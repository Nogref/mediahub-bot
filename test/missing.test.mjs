import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startArrMock } from "./mockArr.mjs";
import { fakeClient, fakeConfig, fakeInteraction, json } from "./helpers.mjs";
import { buildServices } from "../dist/services/index.js";
import { Store } from "../dist/core/db.js";
import { Notifier } from "../dist/notify/notifier.js";
import { Registry } from "../dist/core/registry.js";
import { moduleFactories } from "../dist/modules/index.js";
import { setDefaultTimeout } from "../dist/core/http.js";
import { RoleDirectory } from "../dist/core/roles.js";
import { Access } from "../dist/core/access.js";

let mock;
before(async () => {
  mock = await startArrMock();
  setDefaultTimeout(2000);
});
after(async () => mock.close());
beforeEach(() => mock.reset());

const ADMIN = { roles: ["admin-role"], userId: "admin1" };

function setup() {
  const b = mock.base;
  const cfg = fakeConfig({
    radarr: { url: `${b}/radarr`, apiKey: "rk" },
    sonarr: { url: `${b}/sonarr`, apiKey: "rk" },
    plex: undefined,
    channels: { notify: "c-notify", admin: "c-admin", redownloadLog: "c-rdlog" },
  });
  const store = new Store(cfg.dataDir);
  const client = fakeClient();
  const roles = new RoleDirectory(store, cfg);
  const access = new Access(cfg);
  const ctx = { cfg, store, client, services: buildServices(cfg), notifier: new Notifier(client, store, cfg, roles), roles, access, bus: new EventEmitter() };
  const modules = moduleFactories.map((f) => f(ctx)).filter(Boolean);
  const registry = new Registry(modules, cfg, access);
  const m = modules.find((x) => x.name === "missing");
  return { client, registry, engine: m.engine, mstore: m.mstore };
}
const base = { guildId: "g1", isAutocomplete: () => false, isRepliable: () => true, isModalSubmit: () => false };
async function slash(registry, name, sub, options = {}, extra = {}) {
  const [group, leaf] = sub?.includes(" ") ? sub.split(" ") : [undefined, sub];
  const i = fakeInteraction({ options: { ...options, __sub: leaf, __group: group }, ...extra });
  Object.assign(i, base, { commandName: name, isChatInputCommand: () => true, isMessageComponent: () => false });
  await registry.handle(i);
  return i;
}
async function click(registry, customId, extra = {}, values) {
  const i = fakeInteraction({ customId, ...extra });
  Object.assign(i, base, { values, isChatInputCommand: () => false, isMessageComponent: () => true, isStringSelectMenu: () => !!values });
  await registry.handle(i);
  return i;
}
const text = (p) => (typeof p === "string" ? p : [p?.content ?? "", ...(p?.embeds ?? []).map((e) => JSON.stringify(json(e)))].join("\n"));
const ids = (p) => p.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
};
/** Skip the short pause the bot takes after a search finishes (grabs can land a moment later). */
function pastGrace(env, id) {
  const j = env.mstore.job(id);
  if (j.commandFinishedAt) j.commandFinishedAt -= 60_000;
  else j.commandStartedAt -= 11 * 60_000;
  env.mstore.save(j);
}
async function settle(env, id, rounds = 6) {
  for (let n = 0; n < rounds; n++) {
    await env.engine.tick(id);
    const j = env.mstore.job(id);
    if (j.state !== "searching") return j;
    pastGrace(env, id);
  }
  return env.mstore.job(id);
}
/** /missing → (season) → Get them → job id. */
async function ask(env, options, { season, extra = {} } = {}) {
  let i = await slash(env.registry, "missing", undefined, options, extra);
  let last = i.last();
  if (season !== undefined) {
    const sel = ids(last).find((c) => c.startsWith("msc:season:"));
    assert.ok(sel, `expected a season picker: ${text(last)}`);
    i = await click(env.registry, sel, extra, [String(season)]);
    last = i.last();
  }
  const go = ids(last).find((c) => c.startsWith("msc:go:"));
  assert.ok(go, `expected a card: ${text(last)}`);
  const card = text(last);
  const g = await click(env.registry, go, extra);
  const id = Number(text(g.last()).match(/Missing #(\d+)/)?.[1]);
  assert.ok(id, text(g.last()));
  return { id, card, reply: text(g.last()) };
}

test("/missing: picks the season, lists only aired gaps, downloads, tracks progress, DMs when it's on Plex", async () => {
  const env = setup();
  mock.state.findable.episodes[503] = "The.Show.S01E03.1080p-GOOD";
  const { id, card, reply } = await ask(env, { title: "s:5" }, { season: 1 });
  assert.match(card, /E03 · Three/);
  assert.doesNotMatch(card, /E01|E02/, "episodes already on Plex aren't listed");
  assert.match(card, /1 more hasn't aired yet/);
  assert.match(reply, /On it!.*DMs/s);

  await waitFor(() => mock.state.commands.some((c) => c.name === "EpisodeSearch"));
  assert.deepEqual(mock.state.commands.find((c) => c.name === "EpisodeSearch").episodeIds, [503]);
  assert.ok(mock.state.monitored.includes(503), "asked-for episodes are monitored");
  let j = await settle(env, id);
  assert.equal(j.state, "downloading");
  assert.equal(j.items[0].state, "downloading");
  assert.equal(j.items[0].progress, 25);
  const dm = env.client.messages.get(j.trackerMessageId);
  assert.match(text(dm.edits.at(-1)), /⬇️ E03 · Three: ▰▰▰▱▱▱▱▱▱▱ 25%/);

  mock.arrive(503);
  await env.engine.tick(id);
  j = env.mstore.job(id);
  assert.equal(j.state, "done");
  assert.match(text(env.client.dms.at(-1).payload), /missing episode of \*\*The Show · Season 1\*\* is on Plex now/);
  assert.match(text(dm.edits.at(-1)), /✅ All there/);
  assert.ok(!env.client.sent.some((x) => x.channelId === "c-rdlog" && /couldn't get/.test(x.payload.content ?? "")), "no admin alert when everything arrived");
});

test("whole season missing: season pack first, then one by one; what can't be found goes to the admins", async () => {
  const env = setup();
  mock.state.findable.episodes[601] = "The.Show.S02E01.1080p";
  const { id } = await ask(env, { title: "s:5", season: 2 });
  await waitFor(() => mock.state.commands.some((c) => c.name === "SeasonSearch"));
  let j = await settle(env, id);
  const names = mock.state.commands.map((c) => c.name);
  assert.deepEqual(names.filter((n) => /Search$/.test(n)), ["SeasonSearch", "EpisodeSearch"], "no pack, so it tried the episodes");
  assert.equal(j.state, "downloading");
  assert.deepEqual(j.items.map((i) => i.state), ["downloading", "not_found"]);

  mock.arrive(601);
  await env.engine.tick(id);
  j = env.mstore.job(id);
  assert.equal(j.state, "partial");
  assert.match(text(env.client.dms.at(-1).payload), /1 of 2 missing episodes.*let the admins know/s);
  const alert = env.client.sent.find((x) => x.channelId === "c-rdlog" && /couldn't get/.test(x.payload.content ?? ""));
  assert.match(alert.payload.content, /<@u1> asked for \*\*The Show · Season 2\*\* and I couldn't get 1 of 2/);
  assert.match(alert.payload.content, /E02 · Lost One: no usable release found/);
});

test("a season pack covers the whole season in one go", async () => {
  const env = setup();
  mock.state.findable.packs["5:2"] = "The.Show.S02.1080p-PACK";
  const { id } = await ask(env, { title: "s:5", season: 2 });
  await waitFor(() => mock.state.commands.some((c) => c.name === "SeasonSearch"));
  const j = await settle(env, id);
  assert.deepEqual(j.items.map((i) => i.state), ["downloading", "downloading"]);
  assert.ok(!mock.state.commands.some((c) => c.name === "EpisodeSearch"));
  mock.arrive(601);
  mock.arrive(602);
  await env.engine.tick(id);
  assert.equal(env.mstore.job(id).state, "done");
});

test("movies that never downloaded: listed, searched; not found → told, admins alerted, retry cooldown", async () => {
  const env = setup();
  const ac = fakeInteraction({ options: { __focused: "ali" } });
  Object.assign(ac, { commandName: "missing", guildId: "g1", isChatInputCommand: () => false, isAutocomplete: () => true });
  await env.registry.handle(ac);
  assert.deepEqual(ac.log.at(-1).c, [{ name: "🎬 Alien (1979) · never downloaded", value: "m:2" }]);

  const { id, card } = await ask(env, { title: "m:2" });
  assert.match(card, /never downloaded/);
  await waitFor(() => mock.state.commands.some((c) => c.name === "MoviesSearch"));
  const j = await settle(env, id);
  assert.equal(j.state, "not_found");
  assert.match(text(env.client.dms.at(-1).payload), /couldn't find \*\*Alien \(1979\)\*\* anywhere.*admins know/s);
  assert.ok(env.client.sent.some((x) => x.channelId === "c-rdlog" && /couldn't get it/.test(x.payload.content ?? "")));

  const again = await slash(env.registry, "missing", undefined, { title: "m:2" });
  assert.match(text(again.last()), /I looked for these .* and couldn't get them/);
  const admin = await slash(env.registry, "missing", undefined, { title: "m:2" }, ADMIN);
  assert.ok(ids(admin.last()).some((c) => c.startsWith("msc:go:")), "admins can retry straight away");

  const soon = await slash(env.registry, "missing", undefined, { title: "m:3" });
  assert.match(text(soon.last()), /isn't out to watch at home yet/);
});

test("nothing missing, a lock per season, and choosing specific episodes", async () => {
  const env = setup();
  const done = await slash(env.registry, "missing", undefined, { title: "s:6" });
  assert.match(text(done.last()), /Nothing's missing from \*\*Complete Show\*\*/);

  mock.state.findable.episodes[602] = "The.Show.S02E02.720p";
  // Choose just E02.
  const i = await slash(env.registry, "missing", undefined, { title: "s:5", season: 2 });
  const sid = ids(i.last()).find((c) => c.startsWith("msc:pick:")).split(":")[2];
  const picked = await click(env.registry, `msc:sel:${sid}`, {}, ["602"]);
  assert.match(text(picked.last()), /⬜ E01 · New Start.*☑️ E02 · Lost One/s);
  const go = await click(env.registry, `msc:go:${sid}`);
  const id = Number(text(go.last()).match(/Missing #(\d+)/)[1]);
  assert.deepEqual(env.mstore.job(id).items.map((x) => x.id), [602]);
  await waitFor(() => mock.state.commands.some((c) => c.name === "EpisodeSearch"));
  assert.ok(!mock.state.commands.some((c) => c.name === "SeasonSearch"), "only part of the season: no season pack");

  const twice = await slash(env.registry, "missing", undefined, { title: "s:5", season: 2 }, { userId: "u2" });
  assert.match(text(twice.last()), /already on it \(#\d+\)/);

  // /missing on its own shows what's in progress.
  const st = await slash(env.registry, "missing");
  assert.match(text(st.last()), /Getting The Show · Season 2/);
  assert.ok(ids(st.last()).includes(`mst:refresh:${id}`));
});

test("shared switches: pause and approve-first apply; cancel from the tracker stops the download", async () => {
  const env = setup();
  await slash(env.registry, "admin", "redownloads pause", {}, ADMIN);
  const p = await slash(env.registry, "missing", undefined, { title: "m:2" });
  assert.match(text(p.last()), /paused by an admin/);
  await slash(env.registry, "admin", "redownloads resume", {}, ADMIN);

  await slash(env.registry, "admin", "redownloads approvals", { mode: "on" }, ADMIN);
  mock.state.findable.movies[2] = "Alien.1979.1080p";
  const { id, reply } = await ask(env, { title: "m:2" });
  assert.match(reply, /Sent to the admins/);
  assert.equal(env.mstore.job(id).state, "awaiting_approval");
  assert.ok(!mock.state.commands.length, "nothing searched before approval");
  const nope = await click(env.registry, `msl:approve:${id}`);
  assert.match(text(nope.last()), /Only admins/);
  await click(env.registry, `msl:approve:${id}`, ADMIN);
  const j = await settle(env, id);
  assert.equal(j.state, "downloading");

  await click(env.registry, `mst:cancel:${id}`);
  const stop = await click(env.registry, `mst:stop:${id}`);
  assert.equal(env.mstore.job(id).state, "cancelled");
  assert.match(text(stop.last()), /Cancelled/);
  assert.ok(mock.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/radarr/api/v3/queue/") && c.query.blocklist === "false"));
});
