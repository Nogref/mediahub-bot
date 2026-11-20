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
import { EventEmitter } from "node:events";

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
  const access = new Access(cfg);
  const notifier = new Notifier(client, store, cfg, roles);
  const bus = new EventEmitter();
  const ctx = { cfg, store, client, services, notifier, roles, access, bus };
  let registry;
  const modules = [...moduleFactories, helpModule(() => registry.help)].map((f) => f(ctx)).filter(Boolean);
  registry = new Registry(modules, cfg, access);
  return { cfg, store, services, client, notifier, modules, registry, roles, access, bus, ctx };
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

test("command set: everything registers, gates set, admin-only commands hidden from members", () => {
  const { registry } = setup({ subsonic: { url: `${mock.base}/aurral`, user: "bot", password: "pw", bitrate: 128, idleMinutes: 5 } });
  const usages = registry.help.map((h) => h.usage).sort();
  assert.deepEqual(usages, [
    "/admin aurral link", "/admin plex linked", "/admin plex unlink",
    "/admin redownloads approvals", "/admin redownloads ban", "/admin redownloads history", "/admin redownloads overview",
    "/admin redownloads pause", "/admin redownloads plexcheck", "/admin redownloads resume", "/admin redownloads unban",
    "/admin suggestions review", "/admin suggestions top",
    "/aurral", "/help", "/invite aurral", "/invite create", "/invite list", "/invite revoke",
    "/music play", "/music queue", "/music radio", "/music shuffle", "/music skip", "/music stop",
    "/pings", "/plex", "/plezy", "/random movie", "/redownload start", "/redownload status", "/report",
    "/request album", "/request movie", "/request series", "/requests",
    "/setup channels", "/setup commands-only", "/setup edit", "/setup help", "/setup links", "/setup nowplaying", "/setup pings", "/setup plezy", "/setup reset", "/setup show",
    "/setup stats", "/setup statusboard", "/setup welcome",
    "/stats", "/status", "/suggest",
  ].sort());
  const gated = Object.fromEntries(registry.help.filter((h) => h.gate).map((h) => [h.usage, h.gate]));
  for (const u of ["/invite create", "/invite list", "/invite revoke", "/invite aurral"]) assert.equal(gated[u], "inviter", u);
  for (const u of usages.filter((x) => x.startsWith("/setup ") || x.startsWith("/admin "))) assert.equal(gated[u], "admin", u);
  // Everything else is open to every member.
  for (const u of usages.filter((x) => !/^\/(setup|admin|invite) /.test(x))) assert.equal(gated[u], undefined, u);

  // Members don't even see /setup and /admin in the slash menu.
  const perms = Object.fromEntries(registry.json.map((c) => [c.name, c.default_member_permissions]));
  assert.equal(perms.setup, "32");
  assert.equal(perms.admin, "32");
  for (const [name, p] of Object.entries(perms)) if (name !== "setup" && name !== "admin") assert.equal(p ?? undefined, undefined, name);
  // Grouped admin commands are routable.
  assert.ok(registry.json.find((c) => c.name === "admin").options.some((o) => o.type === 2 && o.name === "redownloads"));
});

test("missing services drop their commands", () => {
  const { registry } = setup({ lidarr: undefined, aurral: undefined, wizarr: undefined, plex: undefined, channels: { notify: "c" } });
  const usages = registry.help.map((h) => h.usage).sort();
  assert.deepEqual(usages, [
    "/admin suggestions review", "/admin suggestions top",
    "/help", "/pings", "/plezy", "/report", "/request movie", "/request series", "/requests",
    "/setup channels", "/setup commands-only", "/setup edit", "/setup help", "/setup links", "/setup pings", "/setup plezy", "/setup reset", "/setup show", "/setup stats", "/setup statusboard", "/setup welcome",
    "/stats", "/status", "/suggest",
  ]);
});

test("/help: short, grouped, plain-language; admin and inviter sections only for them", async () => {
  const { registry } = setup({ subsonic: { url: `${mock.base}/aurral`, user: "bot", password: "pw", bitrate: 128, idleMinutes: 5 } });
  const help = async (extra = {}) => {
    const i = await slash(registry, "help", undefined, {}, extra);
    return json(i.last().embeds[0]);
  };
  const member = await help();
  const names = member.fields.map((f) => f.name);
  assert.deepEqual(names, ["🎬 Get something new", "🛠️ Problems & ideas", "🎵 Music", "ℹ️ Good to know"]);
  const text = JSON.stringify(member);
  assert.match(text, /`\/request movie` · `series` · `album`/);
  assert.doesNotMatch(text, /\/setup|\/admin|\/invite|Seerr|Radarr|Sonarr|Lidarr|Wizarr/);
  assert.doesNotMatch(text, /`\/plex`/, "Plex linking isn't mentioned while it isn't required");
  assert.ok(!member.fields.some((f) => f.name === "➕ More"), "everything is covered by the guide");

  const admin = await help({ roles: ["admin-role"] });
  const adminNames = admin.fields.map((f) => f.name);
  assert.ok(adminNames.includes("🔒 Admin") && adminNames.includes("🎟️ Inviting people"));
  assert.ok(!adminNames.includes("➕ More"));
  assert.ok(JSON.stringify(admin).length < 3000, "fits on a phone screen or two");
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

test("pings: welcome setup creates roles, buttons toggle them, announcements ping roles, music isn't gated", async () => {
  const { registry, client, roles, notifier, store } = setup();
  const { fakeGuild } = await import("./helpers.mjs");
  const guild = fakeGuild(client);
  const run = async (name, sub, options, extra = {}) => {
    const i = fakeInteraction({ options: { ...options, __sub: sub }, ...extra });
    Object.assign(i, { commandName: name, guildId: "g1", guild, channelId: "c-general", isChatInputCommand: () => true, isAutocomplete: () => false, isMessageComponent: () => false, isModalSubmit: () => false, isRepliable: () => true });
    await registry.handle(i);
    return i;
  };
  const press = async (customId, userId = "m1") => {
    const b = fakeInteraction({ customId, userId });
    Object.assign(b, { guildId: "g1", guild, isChatInputCommand: () => false, isAutocomplete: () => false, isMessageComponent: () => true, isModalSubmit: () => false, isRepliable: () => true });
    await registry.handle(b);
    return b;
  };

  const w = await run("setup", "welcome", { channel: { id: "c-welcome" } }, { roles: ["admin-role"] });
  assert.match(w.last().content, /Welcome post posted in <#c-welcome>/);
  assert.equal(guild._roles.size, 4, "ping roles created for the welcome post's button");
  const welcome = client.sent.find((x) => x.channelId === "c-welcome").payload;
  assert.match(welcome.embeds[0].toJSON().title, /Welcome to Test Server/);
  const ids = welcome.components[0].toJSON().components.map((c) => c.custom_id);
  assert.deepEqual(ids, ["optin:open", "posts:plezy"]);

  // Button on the welcome post → private settings, then toggle Music on.
  const open = await press("optin:open");
  assert.match(open.last().embeds[0].toJSON().title, /Your ping settings/);
  const t = await press("optin:music:p");
  assert.match(t.last().content, /\*\*Music\*\* pings are now \*\*on\*\*/);
  assert.ok(guild._memberRoles.get("m1").has(roles.get("music")));

  // Music features are open to people without the Music role.
  const album = await run("request", "album", { query: "album one" }, { userId: "m2", roles: [] });
  assert.doesNotMatch(album.last().content ?? "", /opt-in/);
  assert.ok(album.last().embeds?.length, "album search ran");

  // Announcements ping the ping role of each category in the batch.
  const { parseRadarr, parseLidarr } = await import("../dist/webhooks/arr.js");
  notifier.publish(parseRadarr({ eventType: "Download", movie: { title: "Heat", year: 1995, tmdbId: 949 } }));
  notifier.publish(parseLidarr({ eventType: "Download", artist: { name: "Radiohead" }, album: { title: "Kid A" } }));
  await notifier.flush("c-notify");
  const msg = client.sent.at(-1).payload;
  assert.match(msg.content, new RegExp(`<@&${roles.get("movies")}> <@&${roles.get("music")}>`));
  notifier.stop();
  store.close();
});

test("posts: edit form is pre-filled, saving updates the live post, oversize text becomes a draft, /plezy is public with a cooldown", async () => {
  const { registry, client, store, cfg, bus } = setup();
  const { fakeGuild } = await import("./helpers.mjs");
  const guild = fakeGuild(client);
  const base = { guildId: "g1", guild, channelId: "c-general", isAutocomplete: () => false, isRepliable: () => true };
  const run = async (name, sub, options, extra = {}) => {
    const i = fakeInteraction({ options: { ...options, __sub: sub }, ...extra });
    Object.assign(i, base, { commandName: name, isChatInputCommand: () => true, isMessageComponent: () => false, isModalSubmit: () => false });
    await registry.handle(i);
    return i;
  };
  const admin = { roles: ["admin-role"] };
  await run("setup", "plezy", { channel: { id: "c-guides" } }, admin);
  const live = client.sent.find((x) => x.channelId === "c-guides");
  const liveMsg = client.messages.get(store.kvGet("live.plezy").messageId);
  assert.match(live.payload.embeds.map((e) => e.toJSON().description).join("\n"), /set it to the default \(leave it as it is\)/);
  const links = live.payload.components[0].toJSON().components.map((c) => c.url);
  assert.deepEqual(links, ["https://plezy.app", "https://github.com/edde746/plezy"]);

  // Setting the relay link refreshes the post by itself.
  await run("setup", "links", { plezy_relay: "https://relay.example.com" }, admin);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cfg.links.plezyRelay, "https://relay.example.com");
  assert.match(liveMsg.edits.at(-1).embeds.map((e) => e.toJSON().description).join("\n"), /`https:\/\/relay\.example\.com`/);

  // The editor opens pre-filled.
  const ed = await run("setup", "edit", { post: "welcome" }, admin);
  const modal = ed.log.find((l) => l.type === "modal").m;
  assert.equal(modal.custom_id, "post:welcome");
  assert.equal(modal.components.length, 5);
  assert.match(modal.components[0].components[0].value, /Welcome to \{server\}/);

  const submit = async (name, values) => {
    const m = fakeInteraction({ customId: `post:${name}` });
    Object.assign(m, base, { isChatInputCommand: () => false, isMessageComponent: () => false, isModalSubmit: () => true, fields: { getTextInputValue: (k) => values[k] ?? "" } });
    await registry.handle(m);
    return m;
  };
  // Not placed yet → saved + preview.
  const saved = await submit("welcome", { title: "Hi {server}", s0: "Line one", s1: "", s2: "", s3: "" });
  assert.match(saved.last().content, /Saved\. Post it with/);
  assert.equal(saved.last().embeds[0].toJSON().title, "Hi Test Server");
  assert.deepEqual(store.kvGet("post.welcome"), { title: "Hi {server}", sections: ["Line one", "", "", ""] });

  // Placed → edits in place.
  await submit("plezy", { title: "Get Plezy", s0: "Short version", s1: "", s2: "", s3: "" });
  assert.equal(liveMsg.edits.at(-1).embeds[0].toJSON().title, "Get Plezy");

  // Too long → kept as a draft, live post untouched.
  const big = "x".repeat(3500);
  const tooBig = await submit("plezy", { title: "Big", s0: big, s1: big, s2: "", s3: "" });
  assert.match(tooBig.last().content, /saved as a draft/);
  assert.equal(store.kvGet("post.plezy").title, "Get Plezy");
  assert.equal(store.kvGet("post.plezy.draft").title, "Big");

  // /plezy: public the first time, private copy within the cooldown.
  const p1 = await run("plezy", null, {});
  assert.equal(p1.log.find((l) => l.type === "reply").p.flags, undefined, "visible to everyone");
  const p2 = await run("plezy", null, {});
  assert.ok(p2.log.find((l) => l.type === "reply").p.flags, "second one is ephemeral");
  bus.removeAllListeners();
  store.close();
});

test("settings: /setup channels persists and survives a restart; bot.env fills gaps without overriding", async () => {
  const { registry, cfg, store } = setup();
  const i = fakeInteraction({ options: { __sub: "channels", announcements: { id: "c-new" }, clear: "admin" }, roles: ["admin-role"] });
  Object.assign(i, { commandName: "setup", guildId: "g1", isChatInputCommand: () => true, isAutocomplete: () => false, isMessageComponent: () => false, isModalSubmit: () => false, isRepliable: () => true });
  await registry.handle(i);
  assert.equal(cfg.channels.notify, "c-new");
  assert.equal(cfg.channels.admin, undefined);
  const { applyStoredSettings } = await import("../dist/core/settings.js");
  const fresh = { channels: { notify: "from-env", admin: "env-admin", status: "env-status" }, links: {} };
  applyStoredSettings(fresh, store);
  assert.deepEqual(fresh.channels, { notify: "c-new", admin: undefined, status: "env-status" });

  const { loadEnvFile } = await import("../dist/config.js");
  const fs = await import("node:fs");
  const dir = (await import("./helpers.mjs")).tmpDir();
  fs.writeFileSync(`${dir}/bot.env`, "MB_TEST_A=from-file\nMB_TEST_B=from-file\nMB_TEST_C=\"quoted value\"\n");
  process.env.MB_TEST_A = "from-container";
  process.env.MB_TEST_B = "";
  loadEnvFile(dir);
  assert.equal(process.env.MB_TEST_A, "from-container");
  assert.equal(process.env.MB_TEST_B, "from-file", "blank container value is filled from bot.env");
  assert.equal(process.env.MB_TEST_C, "quoted value");
  store.close();
});

test("stats board: placed once, edited only when a number changes", async () => {
  const { registry, client, store, modules, bus } = setup();
  const i = fakeInteraction({ options: { __sub: "stats", channel: { id: "c-stats" } }, roles: ["admin-role"] });
  Object.assign(i, { commandName: "setup", guildId: "g1", isChatInputCommand: () => true, isAutocomplete: () => false, isMessageComponent: () => false, isModalSubmit: () => false, isRepliable: () => true });
  await registry.handle(i);
  const posted = client.sent.find((x) => x.channelId === "c-stats").payload.embeds[0].toJSON();
  assert.match(posted.title, /Library at a glance/);
  assert.ok(posted.fields.some((f) => /3 movies/.test(f.value)));
  assert.ok(posted.fields.some((f) => /Nothing yet this week/.test(f.value)));
  const msg = client.messages.get(store.kvGet("live.stats").messageId);

  const statsMod = modules.find((m) => m.name === "stats");
  await statsMod.start();
  const settle = () => new Promise((r) => setTimeout(r, 150));
  bus.emit("stats-refresh");
  await settle();
  assert.equal(msg.edits.length, 0, "no edit when nothing changed");

  store.addRequest({ discordUserId: "x", kind: "movie", target: "seerr", title: "Y", tmdbId: 5 });
  bus.emit("stats-refresh");
  await settle();
  assert.equal(msg.edits.length, 1, "edited once the numbers changed");
  assert.ok(msg.edits[0].embeds[0].toJSON().fields.some((f) => /1 · 1 movies/.test(f.value)));
  statsMod.stop();
  bus.removeAllListeners();
  store.close();
});

test("aurral: /aurral creates the account and DMs the login once; taken names and links handled", async () => {
  mock.state.aurralUsers = [{ id: 1, username: "admin", role: "admin" }, { id: 2, username: "taken", role: "user" }];
  const { registry, client, store } = setup();
  const run = async (path, options, extra = {}) => {
    const [cmd, ...rest] = path.split(" ");
    const sub = rest.at(-1);
    const group = rest.length > 1 ? rest[0] : undefined;
    const i = fakeInteraction({ options: { ...options, __sub: sub, __group: group }, ...extra });
    Object.assign(i, { commandName: cmd, guildId: "g1", user: { id: extra.userId ?? "u1", username: extra.username ?? "Alex.B!" }, isChatInputCommand: () => true, isAutocomplete: () => false, isMessageComponent: () => false, isModalSubmit: () => false, isRepliable: () => true });
    await registry.handle(i);
    return i;
  };
  const r1 = await run("aurral", {});
  const post = mock.calls.filter((x) => x.method === "POST" && x.path === "/aurral/api/users").at(-1);
  assert.equal(post.body.username, "alex.b");
  assert.equal(post.body.role, "user");
  assert.ok(post.body.password.length >= 16);
  assert.match(r1.last().content, /sent your login in a DM/);
  const desc = client.dms.at(-1).payload.embeds[0].toJSON().description;
  assert.match(desc, new RegExp(`\\|\\|\`${post.body.password}\`\\|\\|`));
  assert.equal(store.aurralAccount("u1").username, "alex.b");

  const again = await run("aurral", {});
  assert.match(JSON.stringify(again.last().embeds[0].toJSON()), /Your Aurral account.*alex\.b/s, "running it again just shows your login");
  assert.doesNotMatch(JSON.stringify(again.last().embeds[0].toJSON()), new RegExp(post.body.password), "password never shown again");

  const taken = await run("aurral", { username: "taken" }, { userId: "u2", username: "sam" });
  assert.match(taken.last().content, /already an Aurral account called `taken`/);

  const linked = await run("admin aurral link", { user: { id: "u2" }, username: "taken" }, { roles: ["admin-role"], userId: "boss" });
  assert.match(linked.last().content, /linked to the Aurral account `taken`/);
  assert.equal(store.aurralAccount("u2").username, "taken");

  const denied = await run("invite aurral", { user: { id: "u3", username: "kim", bot: false } }, { roles: [], userId: "u4" });
  assert.match(denied.last().content, /Inviter role/);
  store.close();
});

test("live messages: deleted messages are re-posted on the next update", async () => {
  const { LiveMessage } = await import("../dist/core/liveMessage.js");
  const { client, store } = setup();
  const lm = new LiveMessage(client, store, "t");
  const first = await lm.place("c-x", { content: "v1" });
  assert.equal(await lm.update({ content: "v2" }), true);
  assert.equal(client.messages.get(first.id).edits.at(-1).content, "v2");
  client.messages.get(first.id).deleted = true;
  await lm.update({ content: "v3" });
  assert.notEqual(lm.location.messageId, first.id);
  assert.equal(client.sent.at(-1).payload.content, "v3");
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
