import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fakeClient, fakeConfig, fakeInteraction, json } from "./helpers.mjs";
import { Store } from "../dist/core/db.js";
import { Notifier } from "../dist/notify/notifier.js";
import { Registry } from "../dist/core/registry.js";
import { RoleDirectory } from "../dist/core/roles.js";
import { Access } from "../dist/core/access.js";
import { moduleFactories } from "../dist/modules/index.js";
import { helpModule } from "../dist/modules/help.js";

const ADMIN = { roles: ["admin-role"], userId: "admin1" };

function setup() {
  const cfg = fakeConfig({ channels: { notify: "c-notify", admin: "c-admin", suggestions: "c-sug" } });
  const store = new Store(cfg.dataDir);
  const client = fakeClient();
  const access = new Access(cfg);
  const roles = new RoleDirectory(store, cfg);
  const bus = new EventEmitter();
  const ctx = { cfg, store, client, services: {}, notifier: new Notifier(client, store, cfg, roles), roles, access, bus };
  let registry;
  const modules = [...moduleFactories, helpModule(() => registry.help)].map((f) => f(ctx)).filter(Boolean);
  registry = new Registry(modules, cfg, access);
  return { cfg, store, client, registry, modules, bus };
}
async function slash(registry, name, sub, options = {}, extra = {}) {
  const i = fakeInteraction({ options: { ...options, __sub: sub }, ...extra });
  Object.assign(i, { commandName: name, guildId: "g1", isChatInputCommand: () => true, isAutocomplete: () => false, isMessageComponent: () => false, isModalSubmit: () => false, isRepliable: () => true });
  await registry.handle(i);
  return i;
}
const text = (p) => (typeof p === "string" ? p : [p?.content ?? "", ...(p?.embeds ?? []).map((e) => JSON.stringify(json(e)))].join("\n"));

/** A message as discord.js hands it to messageCreate. */
function message(client, { channelId = "c-general", userId = "u5", roles = [], bot = false, at = Date.now(), pinned = false, system = false, thread } = {}) {
  const m = {
    deleted: false,
    guildId: "g1",
    channelId: thread ?? channelId,
    createdTimestamp: at,
    author: { id: userId, bot },
    webhookId: null,
    system,
    pinned,
    member: { id: userId, roles: { cache: new Set(roles) }, permissions: { has: () => false }, guild: { ownerId: "owner1" } },
    channel: {
      isThread: () => !!thread,
      parentId: thread ? channelId : null,
      isSendable: () => true,
      send: async (p) => {
        client.sent.push({ channelId: m.channelId, payload: p });
        return { delete: async () => undefined };
      },
    },
    async delete() {
      m.deleted = true;
    },
  };
  return m;
}
const deliver = async (client, m) => {
  client.emit("messageCreate", m);
  await new Promise((r) => setTimeout(r, 30));
  return m;
};

test("commands-only: removes members' messages (with one friendly DM), never bots, admins, old or pinned messages", async () => {
  const env = setup();
  const before = Date.now() - 60_000;
  const on = await slash(env.registry, "setup", "commands-only", { channel: { id: "c-general" }, mode: "on" }, ADMIN);
  assert.match(text(on.last()), /now \*\*commands-only\*\*/);

  const m1 = await deliver(env.client, message(env.client));
  assert.ok(m1.deleted, "a member's message is removed");
  assert.equal(env.client.dms.length, 1);
  assert.match(text(env.client.dms[0].payload), /removed: that channel is just for bot commands.*Type \*\*\/\*\*/s);
  const m2 = await deliver(env.client, message(env.client));
  assert.ok(m2.deleted);
  assert.equal(env.client.dms.length, 1, "no DM spam: once every few hours");

  for (const [why, opts] of [
    ["admins", { roles: ["admin-role"] }],
    ["the owner", { userId: "owner1" }],
    ["bots", { bot: true }],
    ["pinned", { pinned: true }],
    ["system messages", { system: true }],
    ["messages from before it was switched on", { at: before }],
    ["other channels", { channelId: "c-chat" }],
  ]) {
    const m = await deliver(env.client, message(env.client, opts));
    assert.equal(m.deleted, false, why);
  }
  const t = await deliver(env.client, message(env.client, { thread: "t-1", userId: "u6" }));
  assert.ok(t.deleted, "threads in that channel count too");

  // Closed DMs: a short note in the channel instead.
  env.client.closedDMs.add("u7");
  await deliver(env.client, message(env.client, { userId: "u7" }));
  assert.match(env.client.sent.at(-1).payload.content, /<@u7> this channel is just for bot commands/);

  await slash(env.registry, "setup", "commands-only", { channel: { id: "c-general" }, mode: "off" }, ADMIN);
  const after = await deliver(env.client, message(env.client, { userId: "u8" }));
  assert.equal(after.deleted, false, "switched off again");

  const show = await slash(env.registry, "setup", "show", {}, ADMIN);
  assert.match(text(show.last()), /Commands-only channels.*none/s);
});

test("commands-only: after a restart, cleans up what was posted while offline (only since it was switched on)", async () => {
  const env = setup();
  await slash(env.registry, "setup", "commands-only", { channel: { id: "c-general" }, mode: "on" }, ADMIN);
  const missed = message(env.client, { userId: "u9" });
  const old = message(env.client, { userId: "u9", at: Date.now() - 86_400_000 });
  const mine = message(env.client, { bot: true });
  env.client.channels.fetch = async () => ({ messages: { fetch: async () => new Map([["1", missed], ["2", old], ["3", mine]]) } });
  await env.modules.find((m) => m.name === "commands-only").start();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(missed.deleted);
  assert.equal(old.deleted, false);
  assert.equal(mine.deleted, false);
});

test("/setup help: posts the everyone-view guide that stays, updates itself, and can be taken down", async () => {
  const env = setup();
  const p = await slash(env.registry, "setup", "help", { channel: { id: "c-commands" } }, ADMIN);
  assert.match(text(p.last()), /Commands guide posted in <#c-commands>/);
  const posted = env.client.sent.find((x) => x.channelId === "c-commands");
  const guide = JSON.stringify(json(posted.payload.embeds[0]));
  assert.match(guide, /📖 Commands/);
  assert.match(guide, /Type \*\*\/\*\* in this channel/);
  assert.match(guide, /\/suggest/);
  assert.doesNotMatch(guide, /\/setup|\/admin|\/invite|Inviting people|🔒/, "only what everyone can use");

  // Members can't post it.
  const nope = await slash(env.registry, "setup", "help", { channel: { id: "c-commands" } });
  assert.match(text(nope.last()), /admins only/);

  // Something that changes the guide edits it in place.
  const msg = [...env.client.messages.values()].find((m) => m.channelId === "c-commands");
  const edits = msg.edits.length;
  env.bus.emit("help-changed");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(msg.edits.length, edits + 1);

  const show = await slash(env.registry, "setup", "show", {}, ADMIN);
  assert.match(text(show.last()), /Commands guide: https:\/\/discord\.com\/channels\/g1\/c-commands\//);

  const rm = await slash(env.registry, "setup", "help", { remove: true }, ADMIN);
  assert.match(text(rm.last()), /taken down/);
});
