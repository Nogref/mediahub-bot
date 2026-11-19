import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mockUpstream.mjs";
import { fakeClient, fakeConfig, fakeInteraction, json } from "./helpers.mjs";
import { buildServices } from "../dist/services/index.js";
import { Store } from "../dist/core/db.js";
import { Notifier } from "../dist/notify/notifier.js";
import { Registry } from "../dist/core/registry.js";
import { moduleFactories } from "../dist/modules/index.js";
import { helpModule } from "../dist/modules/help.js";
import { startServer } from "../dist/web/server.js";
import { setDefaultTimeout } from "../dist/core/http.js";
import { RoleDirectory } from "../dist/core/roles.js";
import { Access } from "../dist/core/access.js";

let mock;
before(async () => {
  mock = await startMock();
  setDefaultTimeout(2000);
});
after(async () => mock.close());

function setup(overrides = {}, sharedClient) {
  const b = mock.base;
  const cfg = fakeConfig({
    seerr: { url: `${b}/seerr`, apiKey: "k", attributeUsers: true },
    lidarr: { url: `${b}/lidarr`, apiKey: "k", qualityProfile: "Lossless" },
    aurral: { url: `${b}/aurral`, apiKey: "k" },
    wizarr: { url: `${b}/wizarr`, apiKey: "k", publicUrl: "https://join.example.com", serverIds: [] },
    plex: { url: `${b}/plex`, token: "t", movieLibraries: [] },
    ...overrides,
  });
  const store = new Store(cfg.dataDir);
  const services = buildServices(cfg);
  const client = sharedClient ?? fakeClient();
  const roles = new RoleDirectory(store, cfg);
  const access = new Access(cfg, roles);
  const notifier = new Notifier(client, store, cfg, roles);
  const ctx = { cfg, store, client, services, notifier, roles, access };
  let registry;
  const modules = [...moduleFactories, helpModule(() => registry.help)].map((f) => f(ctx)).filter(Boolean);
  registry = new Registry(modules, cfg, access);
  return { cfg, store, services, client, notifier, modules, registry, roles, access };
}

/** Route a fake slash command through the registry like Discord would. */
function slash(registry, name, sub, options = {}, extra = {}) {
  const i = fakeInteraction({ options: { ...options, __sub: sub }, ...extra });
  Object.assign(i, {
    commandName: name,
    guildId: "g1",
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isMessageComponent: () => false,
    isRepliable: () => true,
  });
  return registry.handle(i).then(() => i);
}
function click(registry, customId, extra = {}) {
  const i = fakeInteraction({ customId, ...extra });
  Object.assign(i, { guildId: "g1", isChatInputCommand: () => false, isAutocomplete: () => false, isMessageComponent: () => true, isRepliable: () => true });
  return registry.handle(i).then(() => i);
}

test("command set: everything registers, descriptions are valid, gates set", () => {
  const { registry } = setup({ subsonic: { url: `${mock.base}/aurral`, user: "bot", password: "pw", bitrate: 128, idleMinutes: 5 } });
  const usages = registry.help.map((h) => h.usage).sort();
  assert.deepEqual(usages, [
    "/help", "/invite create", "/invite list", "/invite revoke",
    "/music play", "/music queue", "/music radio", "/music shuffle", "/music skip", "/music stop",
    "/optin me", "/optin setup", "/random movie", "/report",
    "/request album", "/request movie", "/request series", "/requests", "/stats", "/status",
    "/statusboard post", "/statusboard repost",
  ]);
  const gated = Object.fromEntries(registry.help.filter((h) => h.gate).map((h) => [h.usage, h.gate]));
  assert.equal(gated["/invite create"], "inviter");
  assert.equal(gated["/statusboard repost"], "admin");
  assert.equal(gated["/optin setup"], "admin");
  assert.equal(gated["/request album"], "music");
  assert.equal(gated["/music play"], "music");
  assert.equal(gated["/request movie"], undefined);
});

test("missing services drop their commands", () => {
  const { registry } = setup({ lidarr: undefined, aurral: undefined, wizarr: undefined, plex: undefined, channels: { notify: "c" } });
  const usages = registry.help.map((h) => h.usage).sort();
  assert.deepEqual(usages, ["/help", "/optin me", "/optin setup", "/report", "/request movie", "/request series", "/requests", "/stats", "/status"]);
});

test("/request movie: search → buttons → request attributed to mapped Seerr user", async () => {
  const { registry, store } = setup();
  const i = await slash(registry, "request", "movie", { query: "matrix" });
  const reply = i.last();
  assert.equal(reply.embeds.length, 3, "persons and tv filtered out");
  const buttons = reply.components[0].toJSON().components;
  assert.equal(buttons[0].custom_id, "seerr:movie:603");
  assert.equal(buttons[1].disabled, true, "available title can't be requested");
  assert.equal(buttons[2].style, 2, "already-requested title shown as secondary");
  assert.match(json(reply.embeds[1]).description, /Already in the library/);

  const c = await click(registry, "seerr:movie:603");
  const post = mock.calls.find((x) => x.method === "POST" && x.path === "/seerr/api/v1/request");
  assert.deepEqual(post.body, { mediaType: "movie", mediaId: 603, userId: 2 });
  assert.equal(post.headers["x-api-key"], "k");
  const done = json(c.last().embeds[0]);
  assert.match(done.title, /Requested: The Matrix \(1999\)/);
  assert.match(done.description, /Approved\. Radarr will pick it up/);
  const [row] = store.pendingRequests();
  assert.equal(row.tmdbId, 603);
  assert.equal(row.seerrRequestId, 77);
  assert.equal(row.discordUserId, "u1");
});

test("/request movie on an already-requested title follows it instead of failing", async () => {
  const { registry, store } = setup();
  const c = await click(registry, "seerr:movie:605", { userId: "u2" });
  assert.match(json(c.last().embeds[0]).title, /Already requested/);
  const row = store.pendingRequests().find((r) => r.discordUserId === "u2");
  assert.equal(row.seerrRequestId, 90);
});

test("/request album via Lidarr: adds artist with defaults, waits for album, monitors, searches", async () => {
  mock.state.lidarrArtists = [];
  mock.state.lidarrAlbums = [];
  mock.state.polls = 0;
  const { registry, store } = setup();
  const i = await slash(registry, "request", "album", { query: "album one" });
  const reply = i.last();
  assert.equal(reply.embeds.length, 1, "artist-only results are skipped");
  const id = reply.components[0].toJSON().components[0].custom_id;
  const c = await click(registry, id);
  const addArtist = mock.calls.find((x) => x.method === "POST" && x.path === "/lidarr/api/v1/artist");
  assert.equal(addArtist.body.foreignArtistId, "ar-1");
  assert.equal(addArtist.body.qualityProfileId, 2, "LIDARR_QUALITY_PROFILE resolved by name");
  assert.equal(addArtist.body.rootFolderPath, "/music/");
  assert.equal(addArtist.body.addOptions.monitor, "none");
  const monitor = mock.calls.find((x) => x.path === "/lidarr/api/v1/album/monitor");
  assert.deepEqual(monitor.body, { albumIds: [55], monitored: true });
  const cmd = mock.calls.find((x) => x.path === "/lidarr/api/v1/command");
  assert.deepEqual(cmd.body, { name: "AlbumSearch", albumIds: [55] });
  const done = json(c.last().embeds[0]);
  assert.match(done.title, /Requested: Album One — Artist A/);
  assert.match(done.description, /Added artist \*\*Artist A\*\*/);
  const row = store.pendingRequests()[0];
  assert.equal(row.lidarrAlbumId, 55);
  assert.equal(row.target, "lidarr");
});

test("/request album falls back to Aurral when Lidarr is unreachable", async () => {
  const { registry, store } = setup({ lidarr: { url: "http://127.0.0.1:9", apiKey: "k" } });
  const i = await slash(registry, "request", "album", { query: "anything" });
  const reply = i.last();
  assert.match(reply.content, /Lidarr isn't reachable right now, so I searched Aurral instead/);
  const id = reply.components[0].toJSON().components[0].custom_id;
  const c = await click(registry, id);
  const req = mock.calls.find((x) => x.method === "POST" && x.path === "/aurral/api/library/albums/request");
  assert.deepEqual(req.body, { albumMbid: "rg-9", albumName: "Aurral Album", artistMbid: "ar-9", artistName: "Band B" });
  const done = json(c.last().embeds[0]);
  assert.equal(done.footer.text, "via Aurral");
  assert.equal(store.pendingRequests()[0].aurralAlbumId, "lib-1");
});

test("a stale music button explains itself", async () => {
  const { registry } = setup();
  const c = await click(registry, "music:nope:0");
  assert.match(c.last().content, /search expired/);
});

test("/invite: admin gate, create with options, list, revoke by name", async () => {
  mock.state.invites = [];
  const { registry, client } = setup();
  const denied = await slash(registry, "invite", "create", { name: "bob" }, { roles: [] });
  assert.match(denied.last().content, /Inviter role/);

  const admin = { roles: ["admin-role"] };
  const c = await slash(registry, "invite", "create", { name: "bob", expiry: "7", uses: "single" }, admin);
  const post = mock.calls.filter((x) => x.method === "POST" && x.path === "/wizarr/api/invitations").at(-1);
  assert.deepEqual(post.body, { server_ids: [1], unlimited: false, expires_in_days: 7 }, "only the Plex server is targeted");
  const card = json(c.last().embeds[0]);
  assert.match(card.description, /https:\/\/join\.example\.com\/j\/CODE\d+XYZ/);
  assert.equal(card.fields.find((f) => f.name === "Uses").value, "Single use");
  assert.ok(client.sent.some((s) => s.channelId === "c-admin" && /created invite \*\*bob\*\*/.test(s.payload.content)), "audit posted");

  const dup = await slash(registry, "invite", "create", { name: "BOB" }, admin);
  assert.match(dup.last().content, /already an active invite called/);

  const l = await slash(registry, "invite", "list", {}, admin);
  assert.match(json(l.last().embeds[0]).description, /\*\*bob\*\* · `CODE\d+XYZ` · 1 use left · expires <t:\d+:R>/);

  const r = await slash(registry, "invite", "revoke", { name: "bob" }, admin);
  assert.match(r.last().content, /Revoked invite \*\*bob\*\*/);
  assert.equal(mock.state.invites.length, 0);
});

test("/random movie attaches the Plex poster and links to app.plex.tv", async () => {
  const { registry } = setup();
  const i = await slash(registry, "random", "movie");
  const reply = i.last();
  assert.match(json(reply.embeds[0]).title, /Heat \(1995\)/);
  assert.equal(reply.files.length, 1);
  const btns = reply.components[0].toJSON().components;
  assert.equal(btns[0].custom_id, "random:movie");
  assert.match(btns[1].url, /app\.plex\.tv\/desktop\/#!\/server\/abc123\/details\?key=%2Flibrary%2Fmetadata%2F42/);
  const transcode = mock.calls.find((x) => x.path === "/plex/photo/:/transcode");
  assert.equal(transcode.headers["x-plex-token"], "t");
});

test("/stats aggregates Plex, Lidarr and Seerr; /status shows each service", async () => {
  const { registry } = setup();
  const s = await slash(registry, "stats", null);
  const fields = json(s.last().embeds[0]).fields;
  assert.match(fields[0].value, /\*\*Movies\*\*: 3 movies/);
  assert.match(fields[0].value, /\*\*TV\*\*: 7 shows · 120 episodes/);
  assert.match(fields[1].value, /monitored artists/);
  assert.match(fields[2].value, /12 total · 8 movies · 4 series/);
  const st = await slash(registry, "status", null);
  const desc = json(st.last().embeds[0]).description;
  for (const n of ["Plex", "Seerr", "Lidarr", "Aurral", "Wizarr"]) assert.match(desc, new RegExp(`✅ \\*\\*${n}\\*\\* · \\d+ ms`));
});

test("status board: posts once, reuses it after restart, reposts if deleted, skips no-op edits", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const status = { intervalSeconds: 0.2, refreshMinutes: 5, failThreshold: 2, slowMs: 2000 };
  const first = setup({ status });
  const { client, cfg } = first;
  const run = async (inst) => {
    const board = inst.modules.find((m) => m.name === "status-board");
    await board.start();
    await sleep(1100); // ~5 more ticks with nothing changing
    board.stop();
  };

  await run(first);
  let posts = client.sent.filter((s) => s.channelId === "c-status");
  assert.equal(posts.length, 1, "one board message");
  const stored = first.store.kvGet("statusboard");
  const msg = client.messages.get(stored.messageId);
  assert.equal(msg.edits.length, 0, "no edits while nothing changed");
  assert.match(json(posts[0].payload.embeds[0]).description, /All systems operational/);

  // "Restart": new modules over the same data dir find and reuse the stored message.
  const second = setup({ status, dataDir: cfg.dataDir }, client);
  await run(second);
  posts = client.sent.filter((s) => s.channelId === "c-status");
  assert.equal(posts.length, 1, "no duplicate board after restart");
  assert.equal(msg.edits.length, 1, "one refresh edit on startup only");

  // Message deleted while the bot was down → a new board is posted and remembered.
  msg.deleted = true;
  const third = setup({ status, dataDir: cfg.dataDir }, client);
  await run(third);
  posts = client.sent.filter((s) => s.channelId === "c-status");
  assert.equal(posts.length, 2);
  assert.notEqual(third.store.kvGet("statusboard").messageId, stored.messageId);
});

test("webhook server: secret enforced, unknown service 404, events reach the notifier", async () => {
  const { modules, client, notifier, store } = setup();
  const server = startServer(0, modules, client, () => ({ commands: { ok: false, error: "Missing Access", hint: "re-invite" } }));
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const url = (s, q = "") => `http://127.0.0.1:${port}/webhook/${s}${q}`;
  const body = JSON.stringify({ notification_type: "MEDIA_AVAILABLE", subject: "Heat (1995)", media: { media_type: "movie", tmdbId: "949" } });

  assert.equal((await fetch(url("seerr"), { method: "POST", body })).status, 401);
  assert.equal((await fetch(url("seerr", "?secret=nope"), { method: "POST", body })).status, 401);
  assert.equal((await fetch(url("plexx", "?secret=s3cret"), { method: "POST", body })).status, 404);
  assert.equal((await fetch(url("seerr", "?secret=s3cret"), { method: "POST", body: "{not json" })).status, 400);
  const ok = await fetch(url("seerr"), { method: "POST", body, headers: { "X-Webhook-Secret": "s3cret", "Content-Type": "application/json" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, accepted: 1 });
  const play = await fetch(url("tautulli", "?secret=s3cret"), { method: "POST", body: JSON.stringify({ action: "play", media_type: "movie", title: "X" }) });
  assert.deepEqual(await play.json(), { ok: true, accepted: 0 });
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).commands, { ok: false, error: "Missing Access", hint: "re-invite" });

  await notifier.flush("c-notify");
  assert.match(json(client.sent.at(-1).payload.embeds[0]).title, /Heat \(1995\)/);
  notifier.stop();
  server.close();
  store.close();
});

test("request tracker pings requesters when a webhook was missed", async () => {
  const { store, client, notifier, services, cfg } = setup();
  const { checkPendingRequests } = await import("../dist/modules/requestTracker.js");
  store.addRequest({ discordUserId: "u1", kind: "movie", target: "seerr", title: "The Matrix", year: 1999, tmdbId: 603, seerrRequestId: 77 });
  store.addRequest({ discordUserId: "u2", kind: "album", target: "lidarr", title: "Album One", artistName: "Artist A", mbAlbumId: "rg-1", lidarrAlbumId: 55 });
  store.addRequest({ discordUserId: "u3", kind: "album", target: "aurral", title: "Aurral Album", artistName: "Band B", aurralAlbumId: "lib-1" });
  const n = await checkPendingRequests({ store, client, notifier, services, cfg });
  assert.equal(n, 3);
  await notifier.flush("c-notify");
  const msg = client.sent.at(-1).payload;
  assert.match(msg.content, /<@u1> — \*\*The Matrix \(1999\)\*\* is ready on Plex/);
  assert.match(msg.content, /<@u2> — \*\*Album One — Artist A\*\* is ready to stream/);
  assert.match(msg.content, /<@u3>/);
  assert.deepEqual(msg.allowedMentions.users.sort(), ["u1", "u2", "u3"]);
  assert.equal(store.pendingRequests().length, 0);
  notifier.stop();
});

test("inviters: forced single-use + 7-day expiry, max 3 active, only their own invites", async () => {
  mock.state.invites = [];
  const { registry } = setup();
  const inviter = { roles: ["inviter-role"], userId: "inv1" };
  const first = await slash(registry, "invite", "create", { name: "a1", expiry: "never", uses: "unlimited" }, inviter);
  const post = mock.calls.filter((x) => x.method === "POST" && x.path === "/wizarr/api/invitations").at(-1);
  assert.deepEqual(post.body, { server_ids: [1], unlimited: false, expires_in_days: 7 });
  const note = json(first.last().embeds[0]).fields.find((f) => f.name === "Note").value;
  assert.match(note, /single use/);
  assert.match(note, /at most 7 days/);
  await slash(registry, "invite", "create", { name: "a2" }, inviter);
  await slash(registry, "invite", "create", { name: "a3" }, inviter);
  const fourth = await slash(registry, "invite", "create", { name: "a4" }, inviter);
  assert.match(fourth.last().content, /already have 3 active invites \(the limit is 3\)/);

  // An admin's invite isn't visible to (or revocable by) the inviter.
  await slash(registry, "invite", "create", { name: "adminone" }, { roles: ["admin-role"], userId: "boss" });
  const l = await slash(registry, "invite", "list", {}, inviter);
  const desc = json(l.last().embeds[0]).description;
  assert.match(desc, /a1/);
  assert.doesNotMatch(desc, /adminone/);
  const r = await slash(registry, "invite", "revoke", { name: "adminone" }, inviter);
  assert.match(r.last().content, /No invite of yours/);
});

test("/invite create user:@bob DMs the link, and falls back when DMs are closed", async () => {
  mock.state.invites = [];
  const { registry, client } = setup();
  const admin = { roles: ["admin-role"] };
  const bob = { id: "bob1", username: "bob", bot: false };
  const c = await slash(registry, "invite", "create", { user: bob }, admin);
  assert.equal(client.dms.length, 1);
  assert.equal(client.dms[0].to, "bob1");
  assert.match(json(client.dms[0].payload.embeds[0]).description, /https:\/\/join\.example\.com\/j\//);
  assert.match(json(c.last().embeds[0]).description, /Sent to <@bob1> by DM/);

  client.closedDMs.add("carl1");
  const c2 = await slash(registry, "invite", "create", { user: { id: "carl1", username: "carl", bot: false } }, admin);
  assert.match(json(c2.last().embeds[0]).description, /couldn't DM <@carl1>.*\n.*\/j\//s);
});

test("/requests shows live progress from Seerr and Lidarr", async () => {
  const { registry, store } = setup();
  store.addRequest({ discordUserId: "u9", kind: "movie", target: "seerr", title: "Dune", year: 2021, tmdbId: 606 });
  store.addRequest({ discordUserId: "u9", kind: "album", target: "lidarr", title: "Queued Album", artistName: "Band", lidarrAlbumId: 56 });
  const id = store.addRequest({ discordUserId: "u9", kind: "movie", target: "seerr", title: "Old One", tmdbId: 1 });
  store.markNotified([id]);
  const i = await slash(registry, "requests", null, {}, { userId: "u9" });
  const d = json(i.last().embeds[0]).description;
  assert.match(d, /\*\*On the way \(2\)\*\*/);
  assert.match(d, /Dune\*\* \(2021\)\n⬇️ Downloading 75% · done <t:\d+:R>/);
  assert.match(d, /Queued Album\*\* — Band\n⬇️ Downloading 60%/);
  assert.match(d, /\*\*Landed recently\*\*\n🎬 \*\*Old One\*\*/);
  const empty = await slash(registry, "requests", null, {}, { userId: "nobody" });
  assert.match(empty.last().content, /haven't requested anything/);
});

test("/report files a Seerr issue and DMs the reporter when Seerr resolves it", async () => {
  mock.state.issueStatus = 1;
  const { registry, client, notifier } = setup();
  const i = await slash(registry, "report", null, { title: "movie:604", problem: "audio", details: "French audio", season: null, episode: null }, { userId: "u1" });
  const post = mock.calls.filter((x) => x.path === "/seerr/api/v1/issue").at(-1);
  assert.deepEqual(post.body, { issueType: 2, message: "French audio", mediaId: 12, userId: 2 });
  assert.match(i.last().content, /Reported \*\*The Matrix Reloaded \(2003\)\*\* to Seerr \(issue #31\)/);

  const { parseSeerr } = await import("../dist/webhooks/seerr.js");
  notifier.publish(parseSeerr({ notification_type: "ISSUE_RESOLVED", subject: "The Matrix Reloaded (2003)", issue: { issue_id: "31" } }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.dms.length, 1);
  assert.equal(client.dms[0].to, "u1");
  assert.match(client.dms[0].payload, /marked fixed/);
  // A second resolve (webhook + poll) doesn't DM twice.
  notifier.publish(parseSeerr({ notification_type: "ISSUE_RESOLVED", issue: { issue_id: "31" } }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.dms.length, 1);
  notifier.stop();
});

test("opt-in: setup creates roles + panel, buttons toggle roles, music unlocks, announcements ping roles", async () => {
  const { registry, client, roles, access, notifier, store } = setup();
  const { fakeGuild } = await import("./helpers.mjs");
  const guild = fakeGuild(client);
  const i = fakeInteraction({ options: { __sub: "setup", channel: { id: "c-welcome" } }, roles: ["admin-role"] });
  Object.assign(i, { commandName: "optin", guildId: "g1", guild, isChatInputCommand: () => true, isAutocomplete: () => false, isMessageComponent: () => false, isRepliable: () => true });
  await registry.handle(i);
  assert.match(i.last().content, /Opt-in panel posted.*Created roles: Movies, TV, Music, Server status/s);
  assert.equal(guild._roles.size, 4);
  assert.ok([...guild._roles.values()].every((r) => r.mentionable));
  const panel = client.sent.find((x) => x.channelId === "c-welcome").payload;
  assert.equal(panel.components[0].toJSON().components.length, 4);

  // Before opting in, music is locked for a regular member.
  const musicRole = roles.get("music");
  const asMember = (extra = {}) => ({ userId: "m1", roles: [...(guild._memberRoles.get("m1") ?? [])], ...extra });
  const locked = await slash(registry, "request", "album", { query: "x" }, asMember());
  assert.match(locked.last().content, /Music is opt-in/);

  const b = fakeInteraction({ customId: "optin:music:p", userId: "m1" });
  Object.assign(b, { guildId: "g1", guild, isChatInputCommand: () => false, isAutocomplete: () => false, isMessageComponent: () => true, isRepliable: () => true });
  await registry.handle(b);
  assert.match(b.last().content, /\*\*Music\*\* is now \*\*on\*\*/);
  assert.ok(guild._memberRoles.get("m1").has(musicRole));
  assert.equal(access.hasMusic({ member: { roles: [musicRole] } }), true);

  // Announcements ping the opt-in role of each category in the batch.
  const { parseRadarr, parseLidarr } = await import("../dist/webhooks/arr.js");
  notifier.publish(parseRadarr({ eventType: "Download", movie: { title: "Heat", year: 1995, tmdbId: 949 } }));
  notifier.publish(parseLidarr({ eventType: "Download", artist: { name: "Radiohead" }, album: { title: "Kid A" } }));
  await notifier.flush("c-notify");
  const msg = client.sent.at(-1).payload;
  assert.match(msg.content, new RegExp(`<@&${roles.get("movies")}> <@&${musicRole}>`));
  assert.deepEqual(msg.allowedMentions.roles.sort(), [roles.get("movies"), musicRole].sort());
  notifier.stop();
  store.close();
});

test("Subsonic client: token auth, falls back to password auth on error 41, rejects bad credentials", async () => {
  const { SubsonicClient } = await import("../dist/services/subsonic.js");
  const base = { url: `${mock.base}/aurral`, password: "pw", bitrate: 96, idleMinutes: 5 };
  const ok = new SubsonicClient({ ...base, user: "bot" });
  const r = await ok.search("radiohead");
  assert.equal(r.songs[0].title, "Paranoid Android");
  const call = mock.calls.filter((x) => x.path === "/aurral/rest/search3").at(-1);
  assert.equal(call.query.u, "bot");
  assert.ok(call.query.t && call.query.s && !call.query.p, "token auth by default");
  const stream = new URL(ok.streamUrl("s1"));
  assert.equal(stream.searchParams.get("format"), "opus");
  assert.equal(stream.searchParams.get("maxBitRate"), "96");

  const tokenless = new SubsonicClient({ ...base, user: "tokenless" });
  await tokenless.health();
  const retry = mock.calls.filter((x) => x.path === "/aurral/rest/ping").at(-1);
  assert.equal(retry.query.p, `enc:${Buffer.from("pw").toString("hex")}`);

  const bad = new SubsonicClient({ ...base, user: "bad" });
  await assert.rejects(bad.health(), /wrong Subsonic username or password/);
});

test("logs never show Subsonic credentials", async () => {
  const { redact } = await import("../dist/core/logger.js");
  assert.equal(redact("http://a/rest/stream?u=bot&t=abc&s=def&p=enc:00&id=1"), "http://a/rest/stream?u=bot&t=***&s=***&p=***&id=1");
});
