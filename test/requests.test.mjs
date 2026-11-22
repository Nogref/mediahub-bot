// The request tracker: DM cards for movies, shows (per season) and albums,
// "not out yet", stalls, approvals, requests made on the Seerr website, and
// what happens when DMs are closed. Radarr/Sonarr come from the stateful mock;
// Seerr is a tiny fake below.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { startArrMock } from "./mockArr.mjs";
import { fakeClient, fakeConfig, fakeInteraction, json } from "./helpers.mjs";
import { buildServices } from "../dist/services/index.js";
import { Store } from "../dist/core/db.js";
import { Notifier } from "../dist/notify/notifier.js";
import { Registry } from "../dist/core/registry.js";
import { moduleFactories } from "../dist/modules/index.js";
import { RoleDirectory } from "../dist/core/roles.js";
import { Access } from "../dist/core/access.js";
import { setDefaultTimeout } from "../dist/core/http.js";
import { setAnnouncements } from "../dist/notify/announce.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JARGON = /Seerr|Radarr|Sonarr|Lidarr|Aurral|indexer|monitored|quality profile/i;

let arr;
let seerr;
const S = { requests: {}, list: [], users: { 1: [], 2: ["u5"] }, media: {} };

function startSeerr() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/^\/seerr\/api\/v1/, "");
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    let m;
    if (p === "/status") return send(200, { version: "3.0.0" });
    if (p === "/request") return send(200, { results: [...S.list].sort((a, b) => b.id - a.id) });
    if ((m = p.match(/^\/request\/(\d+)$/))) return S.requests[m[1]] ? send(200, S.requests[m[1]]) : send(404, { message: "not found" });
    if (p === "/user") return send(200, { results: Object.keys(S.users).map((id) => ({ id: Number(id) })) });
    if ((m = p.match(/^\/user\/(\d+)\/settings\/notifications$/))) return send(200, { discordIds: S.users[m[1]] ?? [] });
    if ((m = p.match(/^\/(movie|tv)\/(\d+)$/))) {
      const d = S.media[m[2]];
      return d ? send(200, { id: Number(m[2]), ...d }) : send(200, { id: Number(m[2]), title: "Something" });
    }
    return send(404, { message: `seerr mock: no route ${p}` });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

before(async () => {
  arr = await startArrMock();
  seerr = await startSeerr();
  setDefaultTimeout(2000);
});
after(async () => {
  await arr.close();
  await seerr.close();
});
beforeEach(() => {
  arr.reset();
  Object.assign(S, { requests: {}, list: [], users: { 1: [], 2: ["u5"] }, media: {} });
});

function setup(overrides = {}) {
  const cfg = fakeConfig({
    radarr: { url: `${arr.base}/radarr`, apiKey: "rk" },
    sonarr: { url: `${arr.base}/sonarr`, apiKey: "rk" },
    seerr: { url: `${seerr.base}/seerr`, apiKey: "k", attributeUsers: false },
    channels: { status: "c-status", notify: "c-notify", admin: "c-admin", redownloadLog: "c-rdlog" },
    ...overrides,
  });
  const store = new Store(cfg.dataDir);
  const services = buildServices(cfg);
  const client = fakeClient();
  const roles = new RoleDirectory(store, cfg);
  const access = new Access(cfg);
  const notifier = new Notifier(client, store, cfg, roles);
  const ctx = { cfg, store, client, services, notifier, roles, access, bus: new EventEmitter() };
  const modules = moduleFactories.map((f) => f(ctx)).filter(Boolean);
  const registry = new Registry(modules, cfg, access);
  const mod = modules.find((m) => m.name === "request-tracker");
  return { cfg, store, client, notifier, registry, engine: mod.engine, tstore: mod.tstore, mod, bus: ctx.bus };
}

const movie = (store, extra = {}) =>
  store.addRequest({ discordUserId: "u1", kind: "movie", target: "seerr", title: "Alien", year: 1979, tmdbId: 348, ...extra });
const show = (store, extra = {}) =>
  store.addRequest({ discordUserId: "u1", kind: "tv", target: "seerr", title: "The Show", year: 2020, tmdbId: 5000, tvdbId: 77, ...extra });

/** The latest version of the DM card for a user (first send, then edits). */
function card(client, user = "u1") {
  const first = client.dms.find((d) => d.to === user && d.payload?.embeds);
  if (!first) return undefined;
  const msg = [...client.messages.values()].find((m) => m.channelId === `dm-${user}` && m.payload === first.payload);
  const latest = msg?.edits.at(-1) ?? first.payload;
  return { ...json(latest.embeds[0]), content: latest.content, components: latest.components };
}
const texts = (client, user = "u1") => client.dms.filter((d) => d.to === user && typeof d.payload === "string").map((d) => d.payload);
const logPosts = (client) => client.sent.filter((s) => s.channelId === "c-rdlog").map((s) => s.payload.content);
const age = (env, id, ms) => {
  const t = env.tstore.get(id);
  t.lastActivityAt = Date.now() - ms;
  t.nextCheckAt = 0;
  env.tstore.save(t);
};

test("movie: finding → downloading with a bar and ETA → on Plex, then one short DM", async () => {
  const env = setup();
  const id = movie(env.store);
  await env.engine.track(id);
  let c = card(env.client);
  assert.match(c.title, /🎬 Alien \(1979\)/);
  assert.match(c.description, /✅ Requested\n▶️ Finding a copy…\n⬜ Download\n⬜ On Plex/);
  assert.match(c.content, /keep this updated|until it's ready/);
  assert.deepEqual(c.components[0].toJSON().components.map((b) => b.custom_id), [`rqt:refresh:${id}`]);

  arr.state.queue.push({ id: 9001, app: "radarr", movieId: 2, size: 4e9, sizeleft: 1e9, status: "downloading", estimatedCompletionTime: new Date(Date.now() + 20 * 60_000).toISOString() });
  await env.engine.tick(id);
  c = card(env.client);
  assert.match(c.description, /✅ Found a copy\n▶️ Downloading {2}▰{8}▱{2} 75% · done <t:\d+:R>/);

  arr.state.queue = [];
  arr.state.movies.find((m) => m.id === 2).hasFile = true;
  await env.engine.tick(id);
  c = card(env.client);
  assert.match(c.title, /✅ Ready: Alien \(1979\)/);
  assert.match(c.description, /It's on Plex now/);
  assert.equal(c.components.length, 0, "no buttons once it's done");
  assert.deepEqual(texts(env.client), ["✅ **Alien (1979)** is on Plex now. Enjoy!"]);
  assert.equal(env.store.requestsForUser("u1").done.length, 1);
  assert.equal(env.client.sent.length, 0, "nothing posted publicly");
  assert.doesNotMatch(JSON.stringify(env.client.dms), JARGON);
});

test("TV: one line per requested season; done when everything that's aired is on Plex", async () => {
  const env = setup();
  S.requests[40] = { id: 40, status: 2, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] };
  const id = show(env.store, { seerrRequestId: 40 });
  arr.state.queue.push({ id: 9002, app: "sonarr", seriesId: 5, episodeId: 601, size: 4e9, sizeleft: 3e9, status: "downloading" });
  await env.engine.track(id);
  let c = card(env.client);
  assert.match(c.title, /📺 The Show \(2020\)/);
  assert.match(c.description, /\*\*Season 1\*\*: 2 of 3 on Plex ▰{7}▱{3} · 1 still to air/);
  assert.match(c.description, /\*\*Season 2\*\*: 0 of 2 on Plex ▱{10} · ⬇️ 1 downloading \(25%\)/);

  arr.state.queue = [];
  for (const e of arr.state.episodes) if ([503, 601, 602].includes(e.id)) e.hasFile = true;
  await env.engine.tick(id);
  c = card(env.client);
  assert.match(c.title, /✅ Ready: The Show/);
  assert.match(texts(env.client)[0], /\*\*The Show \(2020\)\*\* is on Plex now\. Enjoy! 1 more episode is still to air; they'll show up on Plex as they come out\./);
});

test("not out yet: shows the release date, no stall warnings while waiting", async () => {
  const env = setup();
  const id = env.store.addRequest({ discordUserId: "u1", kind: "movie", target: "seerr", title: "Future Film", year: 2027, tmdbId: 999 });
  await env.engine.track(id);
  const c = card(env.client);
  assert.match(c.description, /Not out to watch at home yet \(expected <t:\d+:D>\)/);
  const t = env.tstore.get(id);
  assert.equal(t.state, "not_out");
  assert.ok(t.nextCheckAt - Date.now() > 5 * HOUR, "checked every few hours, not every minute");
  age(env, id, 3 * DAY);
  await env.engine.tick(id);
  assert.equal(env.tstore.get(id).state, "not_out");
  assert.equal(texts(env.client).length, 0);
  assert.equal(logPosts(env.client).length, 0);
});

test("stalled: after 24h with nothing, the member and the admins hear about it once; a download clears it", async () => {
  const env = setup();
  const id = movie(env.store);
  await env.engine.track(id);
  age(env, id, 25 * HOUR);
  await env.engine.tick(id);
  assert.equal(env.tstore.get(id).state, "stalled");
  assert.match(texts(env.client)[0], /Still no luck with \*\*Alien \(1979\)\*\*.*let the admins know/);
  assert.match(logPosts(env.client)[0], /<@u1> asked for \*\*Alien \(1979\)\*\*.*Check Radarr → Wanted/);
  assert.match(card(env.client).description, /Still looking: there's no copy out there yet\. I've told the admins/);

  env.tstore.save({ ...env.tstore.get(id), nextCheckAt: 0 });
  await env.engine.tick(id);
  assert.equal(texts(env.client).length, 1, "told once");
  assert.equal(logPosts(env.client).length, 1);

  arr.state.queue.push({ id: 9003, app: "radarr", movieId: 2, size: 100, sizeleft: 50, status: "downloading" });
  await env.engine.tick(id);
  const t = env.tstore.get(id);
  assert.equal(t.state, "downloading");
  assert.equal(t.stalledAt, undefined);
});

test("waiting for approval doesn't count as stuck; a declined request ends with a DM", async () => {
  const env = setup();
  S.requests[41] = { id: 41, status: 1 };
  const id = movie(env.store, { seerrRequestId: 41 });
  await env.engine.track(id);
  assert.match(card(env.client).description, /▶️ Requested · ⏳ waiting for an admin to approve it/);
  age(env, id, 3 * DAY);
  await env.engine.tick(id);
  assert.equal(env.tstore.get(id).state, "approval");
  assert.equal(logPosts(env.client).length, 0);

  S.requests[41].status = 3;
  await env.engine.tick(id);
  assert.match(card(env.client).title, /Not approved: Alien/);
  assert.deepEqual(texts(env.client), ["🚫 Your request for **Alien (1979)** wasn't approved."]);
  assert.equal(env.store.pendingRequests().length, 0);
});

test("no stall warnings while the apps can't be reached", async () => {
  const env = setup({ radarr: { url: "http://127.0.0.1:9", apiKey: "rk" } });
  const id = movie(env.store);
  await env.engine.track(id);
  age(env, id, 3 * DAY);
  await env.engine.tick(id);
  const t = env.tstore.get(id);
  assert.notEqual(t.state, "stalled");
  assert.equal(texts(env.client).length, 0);
  assert.equal(logPosts(env.client).length, 0);
  assert.ok(t.nextCheckAt - Date.now() > 3 * 60_000, "backs off");
});

test("gives up after REQUEST_TRACK_DAYS and tells both sides", async () => {
  const env = setup();
  const id = movie(env.store);
  await env.engine.track(id);
  env.store.sql.prepare("UPDATE requests SET created_at = ? WHERE id = ?").run(Date.now() - 31 * DAY, id);
  env.tstore.save({ ...env.tstore.get(id), nextCheckAt: 0, stalledAt: Date.now() - 6 * DAY, state: "stalled" });
  await env.engine.tick(id);
  assert.match(card(env.client).title, /Stopped watching: Alien/);
  assert.match(texts(env.client).at(-1), /still hasn't turned up, so I've stopped watching/);
  assert.match(logPosts(env.client).at(-1), /Stopped tracking \*\*Alien \(1979\)\*\*/);
  assert.equal(env.store.pendingRequests().length, 0);
});

test("requests made on the Seerr website get a tracker for members with their Discord ID in Seerr", async () => {
  const env = setup();
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  S.media[348] = { title: "Alien", releaseDate: "1979-05-25", posterPath: "/a.jpg" };
  S.media[1000] = { title: "Old Thing", releaseDate: "1990-01-01" };
  S.list = [
    { id: 500, status: 2, type: "movie", createdAt: ago(10 * 60_000), media: { tmdbId: 348, status: 3 }, requestedBy: { id: 2 } },
    { id: 499, status: 2, type: "movie", createdAt: ago(45 * DAY), media: { tmdbId: 1000, status: 3 }, requestedBy: { id: 2 } },
  ];
  S.requests[500] = { id: 500, status: 2 };
  await env.mod.pollSeerr();
  const c = card(env.client, "u5");
  assert.match(c.title, /Alien \(1979\)/);
  assert.match(c.content, /on the request website/);
  assert.equal(env.store.pendingRequests().length, 1, "older than 30 days: skipped on the first run");

  // Later: no Discord ID → skipped; made with /request → already tracked; brand new → next time.
  const botOne = env.store.addRequest({ discordUserId: "u7", kind: "movie", target: "seerr", title: "Bot One", tmdbId: 7, seerrRequestId: 502 });
  env.bus.emit("request-created", { id: botOne, madeSeerrRequest: 502 });
  await new Promise((r) => setTimeout(r, 100));
  const before = env.client.dms.filter((d) => d.payload?.embeds).length;
  S.list.push(
    { id: 501, status: 2, type: "movie", createdAt: ago(10 * 60_000), media: { tmdbId: 348 }, requestedBy: { id: 1 } },
    { id: 502, status: 2, type: "movie", createdAt: ago(10 * 60_000), media: { tmdbId: 7 }, requestedBy: { id: 2 } },
    { id: 503, status: 2, type: "movie", createdAt: ago(10_000), media: { tmdbId: 348 }, requestedBy: { id: 2 } },
  );
  await env.mod.pollSeerr();
  assert.equal(env.client.dms.filter((d) => d.payload?.embeds).length, before, "nothing new to track yet");
  assert.ok(!env.client.dms.some((d) => d.to === "u5" && d.payload?.embeds && /Bot One/.test(JSON.stringify(d.payload))), "u5 isn't sent the bot's own request");
  assert.equal(env.store.kvGet("requests.seerrSeen").lastId, 502, "the one that's seconds old is looked at next time");
});

test("DMs closed: the reply says so, and nothing goes to announcements unless they're on", async () => {
  const env = setup();
  env.client.closedDMs.add("u1");
  const id = movie(env.store);
  const replies = [];
  await env.engine.track(id, { reply: { editReply: async (p) => void replies.push(p) } });
  assert.match(replies.at(-1).content, /Your DMs are closed, so this message keeps you posted/);
  arr.state.movies.find((m) => m.id === 2).hasFile = true;
  await env.engine.tick(id);
  assert.match(json(replies.at(-1).embeds[0]).title, /Ready: Alien/, "the reply keeps updating");
  assert.equal(env.client.sent.length, 0, "announcements are off: no public @");

  const env2 = setup();
  env2.client.closedDMs.add("u1");
  setAnnouncements(env2.store, true);
  const id2 = env2.store.addRequest({ discordUserId: "u1", kind: "movie", target: "seerr", title: "Heat", year: 1995, tmdbId: 949 });
  arr.state.movies.find((m) => m.id === 1).hasFile = false;
  await env2.engine.track(id2);
  arr.state.movies.find((m) => m.id === 1).hasFile = true;
  await env2.engine.tick(id2);
  const at = env2.client.sent.find((s) => s.channelId === "c-notify");
  assert.match(at.payload.content, /<@u1> ✅ \*\*Heat \(1995\)\*\* is on Plex now/);
});

test("Refresh button: only the requester can use it, and it shows the latest", async () => {
  const env = setup();
  const id = movie(env.store);
  await env.engine.track(id);
  const press = async (userId) => {
    const i = fakeInteraction({ customId: `rqt:refresh:${id}`, userId });
    Object.assign(i, { message: { content: "📬 intro" }, isChatInputCommand: () => false, isAutocomplete: () => false, isMessageComponent: () => true, isModalSubmit: () => false, isRepliable: () => true });
    await env.registry.handle(i);
    return i;
  };
  const other = await press("u2");
  assert.match(other.log.at(-1).p.content, /isn't yours/);
  arr.state.queue.push({ id: 9004, app: "radarr", movieId: 2, size: 100, sizeleft: 10, status: "downloading" });
  const mine = await press("u1");
  const out = mine.log.at(-1).p;
  assert.equal(out.content, "📬 intro");
  assert.match(json(out.embeds[0]).description, /Downloading {2}▰{9}▱ 90%/);
});

test("a webhook for a tracked title checks it straight away", async () => {
  const env = setup();
  const { nudgeDelay } = await import("../dist/modules/requestTracker.js");
  nudgeDelay.ms = 0;
  const id = movie(env.store);
  await env.engine.track(id);
  env.tstore.save({ ...env.tstore.get(id), nextCheckAt: Date.now() + HOUR });
  arr.state.movies.find((m) => m.id === 2).hasFile = true;
  const { parseRadarr } = await import("../dist/webhooks/arr.js");
  env.notifier.publish(parseRadarr({ eventType: "Download", movie: { title: "Alien", year: 1979, tmdbId: 348 } }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(env.tstore.get(id).state, "done");
  assert.match(texts(env.client)[0], /Alien \(1979\)\*\* is on Plex now/);
  env.notifier.stop();
});
