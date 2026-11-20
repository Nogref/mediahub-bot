import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fakeClient, fakeConfig, fakeInteraction, json } from "./helpers.mjs";
import { Store } from "../dist/core/db.js";
import { Notifier } from "../dist/notify/notifier.js";
import { Registry } from "../dist/core/registry.js";
import { RoleDirectory } from "../dist/core/roles.js";
import { Access } from "../dist/core/access.js";
import { suggestions, notFamilyFriendly } from "../dist/modules/suggestions.js";

const ADMIN = { roles: ["admin-role"], userId: "admin1" };

function setup(channels = { suggestions: "c-sug", admin: "c-admin" }) {
  const cfg = fakeConfig({ channels });
  const store = new Store(cfg.dataDir);
  const client = fakeClient();
  const access = new Access(cfg);
  const ctx = { cfg, store, client, services: {}, notifier: new Notifier(client, store, cfg, new RoleDirectory(store, cfg)), roles: new RoleDirectory(store, cfg), access, bus: new EventEmitter() };
  const registry = new Registry([suggestions(ctx)], cfg, access);
  return { cfg, store, client, registry };
}
const base = { guildId: "g1", isAutocomplete: () => false, isRepliable: () => true };
async function slash(registry, name, sub, options = {}, extra = {}) {
  const [group, leaf] = sub?.includes(" ") ? sub.split(" ") : [undefined, sub];
  const i = fakeInteraction({ options: { ...options, __sub: leaf, __group: group }, ...extra });
  Object.assign(i, base, { commandName: name, isChatInputCommand: () => true, isMessageComponent: () => false, isModalSubmit: () => false });
  await registry.handle(i);
  return i;
}
async function modal(registry, customId, values, extra = {}) {
  const i = fakeInteraction({ customId, ...extra });
  Object.assign(i, base, { isChatInputCommand: () => false, isMessageComponent: () => false, isModalSubmit: () => true, fields: { getTextInputValue: (k) => values[k] ?? "" } });
  await registry.handle(i);
  return i;
}
async function click(registry, customId, extra = {}, values) {
  const i = fakeInteraction({ customId, ...extra });
  Object.assign(i, base, { values, isChatInputCommand: () => false, isMessageComponent: () => true, isModalSubmit: () => false, isStringSelectMenu: () => !!values });
  await registry.handle(i);
  return i;
}
const text = (p) => (typeof p === "string" ? p : [p?.content ?? "", ...(p?.embeds ?? []).map((e) => JSON.stringify(json(e)))].join("\n"));
const posted = (client, ch) => client.sent.filter((x) => x.channelId === ch);
async function suggest(env, values, extra = {}) {
  const open = await slash(env.registry, "suggest", undefined, {}, extra);
  assert.equal(open.log.at(-1).type, "modal", `no form shown: ${text(open.last())}`);
  return modal(env.registry, "sug:new", values, extra);
}

test("/suggest opens a clean form the first time (nothing pre-filled)", async () => {
  const env = setup();
  const open = await slash(env.registry, "suggest");
  const form = open.log.at(-1).m;
  assert.equal(open.log.at(-1).type, "modal");
  assert.equal(form.components[0].components[0].value, undefined);
  assert.equal(form.components[1].components[0].value, undefined);
});

test("filter: catches swearing and tricks, leaves normal ideas alone", () => {
  for (const bad of ["this is fucking great", "sh1t quality", "a$$hole"]) assert.ok(notFamilyFriendly(bad), bad);
  for (const ok of ["Add a kids section please", "Hell's Kitchen", "Scunthorpe matches", "assassin's creed"]) assert.ok(!notFamilyFriendly(ok), ok);
});

test("/suggest: a form, then a public post with a 👍 button; voting toggles and says so", async () => {
  const env = setup();
  const m = await suggest(env, { title: "A kids' movies section", details: "So the little ones can find stuff" });
  assert.match(text(m.last()), /It's up: https:\/\/discord\.com\/channels\/g1\/c-sug\//);
  const post = posted(env.client, "c-sug")[0];
  const card = text(post.payload);
  assert.match(card, /💡 A kids' movies section/);
  assert.match(card, /🆕 New idea/);
  const id = post.payload.components[0].toJSON().components[0].custom_id.split(":")[2];

  let v = await click(env.registry, `sug:vote:${id}`, { userId: "u2" });
  assert.equal(v.last().components[0].toJSON().components[0].label, "1");
  assert.match(v.log.find((l) => l.type === "followUp").p.content, /Thanks for voting/);
  v = await click(env.registry, `sug:vote:${id}`, { userId: "u3" });
  assert.equal(v.last().components[0].toJSON().components[0].label, "2");
  v = await click(env.registry, `sug:vote:${id}`, { userId: "u2" });
  assert.equal(v.last().components[0].toJSON().components[0].label, "1", "tapping again takes the vote back");
  assert.match(v.log.find((l) => l.type === "followUp").p.content, /taken back/);
});

test("vulgar text isn't posted: reword it (form comes back filled in) or send it to admins privately", async () => {
  const env = setup();
  const m = await suggest(env, { title: "More shit comedies", details: "" });
  assert.match(text(m.last()), /keep it family-friendly/);
  assert.equal(posted(env.client, "c-sug").length, 0);

  const again = await click(env.registry, "sug:edit");
  const form = again.log.find((l) => l.type === "modal").m;
  assert.equal(form.components[0].components[0].value, "More shit comedies", "their text is kept");

  const priv = await click(env.registry, "sug:private");
  assert.match(text(priv.last()), /Sent to the admins privately/);
  assert.equal(posted(env.client, "c-sug").length, 0);
  const review = posted(env.client, "c-admin")[0];
  assert.match(text(review.payload), /filter caught something/);

  // A false alarm: an admin posts it anyway.
  const id = review.payload.components[0].toJSON().components[0].custom_id.split(":")[2];
  const nope = await click(env.registry, `sug:approve:${id}`);
  assert.match(text(nope.last()), /for admins/);
  await click(env.registry, `sug:approve:${id}`, ADMIN);
  assert.equal(posted(env.client, "c-sug").length, 1);
  assert.match(text(env.client.dms.at(-1).payload), /is up for people to 👍/);
});

test("admins set a status with a note; the member gets a DM; voting closes when it's done", async () => {
  const env = setup();
  await suggest(env, { title: "Movie night every Friday", details: "" });
  const post = posted(env.client, "c-sug")[0];
  const id = post.payload.components[0].toJSON().components[0].custom_id.split(":")[2];

  const member = await click(env.registry, `sug:manage:${id}`, { userId: "u2" });
  assert.match(text(member.last()), /for admins. Tap 👍/);

  const menu = await click(env.registry, `sug:manage:${id}`, ADMIN);
  assert.match(text(menu.last()), /what's the status/);
  const sel = await click(env.registry, `sug:status:${id}`, ADMIN, ["done"]);
  const noteForm = sel.log.find((l) => l.type === "modal").m;
  assert.equal(noteForm.custom_id, `sug:note:${id}:done`);
  await modal(env.registry, `sug:note:${id}:done`, { note: "Starting this week!" }, ADMIN);

  const msg = env.client.messages.get(post.id ?? [...env.client.messages.keys()][0]);
  const latest = msg.edits.at(-1);
  assert.match(text(latest), /✅ Done.*Starting this week!/s);
  assert.equal(latest.components[0].toJSON().components[0].disabled, true);
  assert.match(text(env.client.dms.at(-1).payload), /Good news.*Movie night every Friday.*Starting this week!/s);

  // Remove: the post disappears, no DM.
  await suggest(env, { title: "Buy me a pony", details: "" }, { userId: "u3" });
  const p2 = posted(env.client, "c-sug")[1];
  const id2 = p2.payload.components[0].toJSON().components[0].custom_id.split(":")[2];
  const dmsBefore = env.client.dms.length;
  const r = await click(env.registry, `sug:status:${id2}`, ADMIN, ["removed"]);
  assert.match(text(r.last()), /Removed/);
  assert.equal(env.client.dms.length, dmsBefore);
});

test("review mode: everything waits for an admin; limits; not set up yet", async () => {
  const unset = setup({});
  const s = await slash(unset.registry, "suggest");
  assert.match(text(s.last()), /aren't set up yet/);

  const env = setup();
  await slash(env.registry, "admin", "suggestions review", { mode: "on" }, ADMIN);
  const m = await suggest(env, { title: "Add more anime", details: "" });
  assert.match(text(m.last()), /An admin will take a quick look/);
  assert.equal(posted(env.client, "c-sug").length, 0);
  const review = posted(env.client, "c-admin")[0];
  const id = review.payload.components[0].toJSON().components[0].custom_id.split(":")[2];
  await click(env.registry, `sug:reject:${id}`, ADMIN);
  assert.match(text(env.client.dms.at(-1).payload), /decided not to post it/);
  const twice = await click(env.registry, `sug:approve:${id}`, ADMIN);
  assert.match(text(twice.last()), /gone|already dealt/);

  // 3 a day per member.
  await suggest(env, { title: "Second idea here", details: "" });
  await suggest(env, { title: "Third idea here", details: "" });
  const fourth = await slash(env.registry, "suggest");
  assert.match(text(fourth.last()), /3 ideas in the last 24 hours/);

  const top = await slash(env.registry, "admin", "suggestions top", {}, ADMIN);
  assert.match(text(top.last()), /Second idea here.*waiting for review/s);
});
