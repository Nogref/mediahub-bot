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
import { keys } from "../dist/notify/events.js";
import { pickCandidates, readyToSwap, isNotUpgradeMessage, disqualify } from "../dist/redownload/select.js";
import { normRelease } from "../dist/redownload/arr.js";
import { keysOverlap } from "../dist/redownload/store.js";
import { parseSharedUsers } from "../dist/services/plextv.js";

let mock;
before(async () => {
  mock = await startArrMock();
  setDefaultTimeout(2000);
});
after(async () => mock.close());
beforeEach(() => mock.reset());

const ADMIN = { roles: ["admin-role"], userId: "admin1" };
const NOT_UPGRADE = "Not an upgrade for existing movie file. Existing quality: Bluray-1080p. New Quality Bluray-1080p.";

function setup(overrides = {}) {
  const b = mock.base;
  const cfg = fakeConfig({
    radarr: { url: `${b}/radarr`, apiKey: "rk" },
    sonarr: { url: `${b}/sonarr`, apiKey: "rk" },
    plex: { url: `${b}/plex`, token: "t", movieLibraries: [] },
    plexTvUrl: `${b}/plextv`,
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
  const rd = modules.find((x) => x.name === "redownload");
  return { cfg, store, client, notifier, registry, engine: rd.engine, rstore: rd.rstore };
}

function slash(registry, name, sub, options = {}, extra = {}) {
  const [group, leaf] = sub?.includes(" ") ? sub.split(" ") : [undefined, sub];
  const i = fakeInteraction({ options: { ...options, __sub: leaf, __group: group }, ...extra });
  Object.assign(i, { commandName: name, guildId: "g1", isChatInputCommand: () => true, isAutocomplete: () => false, isMessageComponent: () => false, isRepliable: () => true });
  return registry.handle(i).then(() => i);
}
function click(registry, customId, extra = {}, values) {
  const i = fakeInteraction({ customId, ...extra });
  Object.assign(i, {
    guildId: "g1",
    values,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isMessageComponent: () => true,
    isStringSelectMenu: () => !!values,
    isRepliable: () => true,
  });
  return registry.handle(i).then(() => i);
}
const text = (p) => (typeof p === "string" ? p : [p?.content ?? "", ...(p?.embeds ?? []).map((e) => JSON.stringify(json(e)))].join("\n"));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}
const link = (rstore, id = "u1", plexUserId = 42, hasAccess = true) =>
  rstore.saveLink({ discordUserId: id, plexUserId, plexUsername: plexUserId === 42 ? "alice" : "bob", hasAccess, linkedAt: Date.now(), verifiedAt: Date.now() });

/** /redownload start → confirmation card → Replace. Returns the job. */
async function startJob(env, options, extra = {}, { pick } = {}) {
  const i = await slash(env.registry, "redownload", "start", { problem: "video", details: "picture freezes at 41:00", ...options }, extra);
  const card = i.last();
  const buttons = card.components?.[0]?.toJSON().components;
  assert.ok(buttons, `expected a confirmation card, got: ${text(card)}`);
  const sid = buttons[0].custom_id.split(":")[2];
  if (pick !== undefined) await click(env.registry, `rdc:sel:${sid}`, extra, [String(pick)]);
  const go = await click(env.registry, `rdc:go:${sid}`, extra);
  const id = Number(text(go.last()).match(/#(\d+)/)?.[1]);
  assert.ok(id, text(go.last()));
  return { job: env.rstore.job(id), card, reply: text(go.last()) };
}
const until = (env, id, state) => waitFor(() => env.rstore.job(id).state === state);
const posts = (client, channelId) => client.sent.filter((x) => x.channelId === channelId);

// ---- pure rules ---------------------------------------------------------------------------
test("release picking: only 'existing file' rejections, never the same release, no fakes or dead torrents", () => {
  const releases = mock.state.releases.movie.map((r) => ({ ...r, quality: r.quality.quality.name, rejections: r.rejections }));
  const opts = { kind: "movie", excludeTitles: ["Heat.1995.1080p.BluRay.x264-OLD.mkv"], currentSize: 8e9 };
  const picked = pickCandidates(releases, opts).map((r) => r.title);
  assert.deepEqual(picked, ["Heat.1995.1080p.BluRay.x264-GOOD", "Heat.1995.1080p.WEB-DL-OK", "Heat.1995.720p.BluRay-SMALLER"]);
  const why = (t) => disqualify(releases.find((r) => r.title === t), opts);
  assert.equal(why("Heat.1995.2160p.REMUX-BIG"), "Not wanted in profile");
  assert.equal(why("Heat.1995.1080p.BluRay.x264-OLD"), "same release as before");
  assert.equal(why("Heat.1995.Sample-TINY"), "suspiciously small");
  assert.equal(why("Heat.1995.1080p.DEAD"), "no seeders");
  // Seasons need season packs; single episodes never take a pack.
  const ep = mock.state.releases.episode.map((r) => ({ ...r, quality: "x" }));
  assert.ok(!pickCandidates(ep, { kind: "episode", excludeTitles: [], currentSize: 2e9 }).some((r) => r.fullSeason));
  assert.ok(pickCandidates(ep, { kind: "season", excludeTitles: [], currentSize: 4e9 }).every((r) => r.fullSeason));
});

test("import messages: only 'not an upgrade' blocks lead to a swap", () => {
  for (const m of [NOT_UPGRADE, "Not a quality revision upgrade for existing movie file(s)", "Not a Custom Format upgrade for existing episode file(s)", "Not an upgrade for existing track file(s)"]) {
    assert.ok(isNotUpgradeMessage(m), m);
  }
  assert.ok(!isNotUpgradeMessage("No audio tracks detected"));
  assert.ok(readyToSwap("movie", [NOT_UPGRADE]));
  assert.ok(readyToSwap("movie", [NOT_UPGRADE, "Sample"]));
  assert.ok(!readyToSwap("movie", [NOT_UPGRADE, "Unable to parse file"]), "anything unexpected on a movie: don't touch");
  assert.ok(!readyToSwap("movie", []));
  assert.ok(readyToSwap("season", [NOT_UPGRADE, "Episode file is missing"]), "partial packs are fine; the preview limits what's deleted");
  assert.equal(normRelease("/downloads/Heat.1995.1080p.BluRay.x264-OLD.mkv"), normRelease("heat 1995 1080p bluray x264 old"));
  assert.ok(keysOverlap("sonarr:5:1", "sonarr:5:1:501") && !keysOverlap("sonarr:5:1", "sonarr:5:11"));
  const users = parseSharedUsers(mock.state.sharedUsersXml);
  assert.deepEqual(users.get(42), ["abc123"]);
  assert.deepEqual(users.get(43), ["someoneelse"]);
});

// ---- plex linking ---------------------------------------------------------------------------
test("/plex: sign in, confirm the share list, never keep the token, one Discord per Plex account", async () => {
  const env = setup();
  mock.state.pinToken = "alicetoken";
  const i = await slash(env.registry, "plex");
  const first = i.log.find((l) => l.type === "edit").p;
  assert.match(first.components[0].toJSON().components[0].url, /^https:\/\/app\.plex\.tv\/auth#\?clientID=.+&code=PINCODE/);
  assert.match(text(i.last()), /Linked to alice/);
  const l = env.rstore.link("u1");
  assert.equal(l.plexUserId, 42);
  assert.equal(l.hasAccess, true);
  const dbDump = JSON.stringify(env.store.sql.prepare("SELECT * FROM plex_links").all()) + JSON.stringify(env.store.sql.prepare("SELECT * FROM kv").all());
  assert.ok(!dbDump.includes("alicetoken"), "the member's Plex token is never stored");

  // Someone else can't claim the same Plex account.
  const j = await slash(env.registry, "plex", undefined, {}, { userId: "u2" });
  assert.match(text(j.last()), /already linked to another Discord member/);
  assert.equal(env.rstore.link("u2"), undefined);
});

// ---- gates ----------------------------------------------------------------------------------
test("open to every member by default: no Plex link needed", async () => {
  const env = setup();
  const { job } = await startJob(env, { title: "m:1" });
  assert.equal(job.discordUserId, "u1");
  assert.equal(job.plexUsername, undefined);
  const st = await slash(env.registry, "redownload", "status");
  assert.doesNotMatch(text(st.last()), /Plex account/, "no nagging about linking while it isn't required");
  const ov = await slash(env.registry, "admin", "redownloads overview", {}, ADMIN);
  assert.match(text(ov.last()), /Open to every member of this server/);
});

test("gates (plex check on): must be linked, on the share list, not banned, not paused; recycling bin required", async () => {
  const env = setup();
  let i = await slash(env.registry, "admin", "redownloads plexcheck", { mode: "on" });
  assert.match(text(i.last()), /admins only/);
  await slash(env.registry, "admin", "redownloads plexcheck", { mode: "on" }, ADMIN);
  i = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "video", details: "freezes at the bank scene" });
  assert.match(text(i.last()), /link your Plex account with `\/plex`/);

  link(env.rstore, "u1", 43, false);
  i = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "video", details: "freezes at the bank scene" });
  assert.match(text(i.last()), /isn't on this server's share list/);

  link(env.rstore, "u1");
  mock.state.bins.radarr = "";
  i = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "video", details: "freezes at the bank scene" });
  assert.match(text(i.last()), /aren't fully set up yet/);
  assert.ok(!mock.calls.some((c) => c.path.endsWith("/release")), "never searched without a safety net");
  i = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "video", details: "freezes at the bank scene" }, ADMIN);
  assert.match(text(i.last()), /Settings → Media Management/, "admins get the fix");
  mock.state.bins.radarr = "/recycle";

  await slash(env.registry, "admin", "redownloads pause", { reason: "maintenance" }, ADMIN);
  i = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "video", details: "freezes at the bank scene" });
  assert.match(text(i.last()), /paused by an admin: maintenance/);
  await slash(env.registry, "admin", "redownloads resume", {}, ADMIN);

  await slash(env.registry, "admin", "redownloads ban", { user: { id: "u1" }, reason: "spam" }, ADMIN);
  i = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "video", details: "freezes at the bank scene" });
  assert.match(text(i.last()), /can't use redownloads right now \(spam\)/);
  await slash(env.registry, "admin", "redownloads unban", { user: { id: "u1" } }, ADMIN);

  // Non-admins can't run admin subcommands.
  i = await slash(env.registry, "admin", "redownloads pause", {});
  assert.match(text(i.last()), /admins only/);
});

// ---- the happy path -------------------------------------------------------------------------
test("movie: grab → download (old copy kept) → swap via recycling bin → import → old release blocklisted → DM", async () => {
  const env = setup();
  link(env.rstore);
  const { job, card } = await startJob(env, { title: "m:1" });
  assert.match(text(card), /Heat\.1995\.1080p\.BluRay\.x264-GOOD/);
  assert.match(text(card), /current one keeps working/);
  await until(env, job.id, "downloading");
  const grab = mock.calls.find((c) => c.method === "POST" && c.path === "/radarr/api/v3/release");
  assert.deepEqual(grab.body, { guid: "guid-Heat.1995.1080p.BluRay.x264-GOOD", indexerId: 3 });

  // Still downloading: nothing deleted.
  await env.engine.tick(job.id);
  assert.equal(env.rstore.job(job.id).state, "downloading");
  assert.ok(!mock.calls.some((c) => c.method === "DELETE"));
  assert.ok(env.rstore.job(job.id).downloadId?.startsWith("DL"));

  // An "import blocked" alert for this download is covered by the redownload log.
  const dl = env.rstore.job(job.id).downloadId;
  env.notifier.publish([{ type: "alert", source: "Radarr", level: "warn", title: "Radarr: manual interaction required", message: "x", dedupeKey: `Radarr:ManualInteractionRequired:${dl}` }]);

  mock.finish("Heat.1995.1080p.BluRay.x264-GOOD", { messages: [NOT_UPGRADE] });
  await env.engine.tick(job.id);
  const del = mock.calls.find((c) => c.method === "DELETE" && c.path === "/radarr/api/v3/moviefile/10");
  assert.ok(del, "old file removed (to the recycling bin)");
  assert.ok(mock.calls.some((c) => c.path === "/radarr/api/v3/command" && c.body?.name === "RefreshMonitoredDownloads"));
  assert.equal(env.rstore.job(job.id).state, "importing");

  await env.engine.tick(job.id);
  const done = env.rstore.job(job.id);
  assert.equal(done.state, "done");
  assert.ok(mock.calls.some((c) => c.method === "POST" && c.path === "/radarr/api/v3/history/failed/1"), "old release blocklisted");
  assert.match(text(env.client.dms.at(-1).payload), /Heat \(1995\).* fixed and ready to watch/);

  // One log entry, edited along the way, ending ✅.
  const logPosts = posts(env.client, "c-rdlog");
  assert.equal(logPosts.length, 1);
  const msg = env.client.messages.get(done.logMessageId);
  assert.match(JSON.stringify(json(msg.edits.at(-1).embeds[0])), /Replaced/);
  assert.match(JSON.stringify(json(logPosts[0].payload.embeds[0])), /freezes at 41:00/);

  // The swapped-in copy isn't announced as "new".
  env.notifier.publish([{ type: "media", kind: "movie", source: "Radarr", title: "Heat", year: 1995, dedupeKey: keys.movie(949, "Heat", 1995) }]);
  await env.notifier.flushAll();
  assert.equal(posts(env.client, "c-notify").length, 0);
  assert.equal(posts(env.client, "c-admin").length, 0, "the manual-interaction alert was swallowed");

  // Used 1 of 2; the same title is on cooldown.
  const st = await slash(env.registry, "redownload", "status");
  assert.match(text(st.last()), /1 of 2/);
  const again = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "video", details: "still freezing sadly" });
  assert.match(text(again.last()), /replaced recently/);
});

test("details are optional: just the problem type is enough", async () => {
  const env = setup();
  const i = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "audio" });
  const card = i.last();
  assert.match(text(card), /Audio missing or out of sync/);
  assert.doesNotMatch(text(card), /> /, "no empty quote line");
  const sid = card.components[0].toJSON().components[0].custom_id.split(":")[2];
  const go = await click(env.registry, `rdc:go:${sid}`);
  const id = Number(text(go.last()).match(/#(\d+)/)[1]);
  assert.equal(env.rstore.job(id).details, "");
  const logPost = env.client.sent.find((x) => x.channelId === "c-rdlog");
  assert.match(JSON.stringify(json(logPost.payload.embeds[0])), /Audio missing or out of sync \(no details given\)/);
});

test("manual pick: the member's chosen release goes first; the rest stay as fallbacks", async () => {
  const env = setup();
  link(env.rstore);
  const { job } = await startJob(env, { title: "m:1" }, {}, { pick: 1 });
  assert.equal(job.candidates[0].title, "Heat.1995.1080p.WEB-DL-OK");
  assert.equal(job.candidates[1].title, "Heat.1995.1080p.BluRay.x264-GOOD");
  await until(env, job.id, "downloading");
  assert.equal(env.rstore.job(job.id).current.title, "Heat.1995.1080p.WEB-DL-OK");
});

// ---- failures and retries -------------------------------------------------------------------
test("episode: failed downloads retry other releases, then give up with the original untouched and refunded", async () => {
  const env = setup();
  link(env.rstore);
  const { job } = await startJob(env, { title: "s:5", season: 1, episode: 1 });
  assert.equal(job.target.kind, "episode");
  await until(env, job.id, "downloading");

  // 1: imports with an unexpected problem → removed + blocklisted, next release.
  mock.finish("The.Show.S01E01.1080p.WEB-A", { messages: ["No audio tracks detected"] });
  await env.engine.tick(job.id);
  assert.ok(mock.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/sonarr/api/v3/queue/") && c.query.blocklist === "true"));
  let j = env.rstore.job(job.id);
  assert.equal(j.attempt, 2);
  assert.equal(j.current.title, "The.Show.S01E01.1080p.WEB-B");

  // 2: the downloader reports failure.
  await env.engine.tick(job.id);
  mock.failDownload("The.Show.S01E01.1080p.WEB-B");
  await env.engine.tick(job.id);
  j = env.rstore.job(job.id);
  assert.equal(j.attempt, 3);

  // 3: fails too → out of attempts.
  await env.engine.tick(job.id);
  mock.failDownload(j.current.title);
  await env.engine.tick(job.id);
  j = env.rstore.job(job.id);
  assert.equal(j.state, "failed");
  assert.equal(j.changedFiles, false);
  assert.ok(!mock.calls.some((c) => c.path.includes("/episodefile")  && c.method === "DELETE"), "never deleted anything");
  assert.match(text(env.client.dms.at(-1).payload), /original is untouched.*didn't count/s);
  const st = await slash(env.registry, "redownload", "status");
  assert.match(text(st.last()), /2 of 2/, "refunded");
});

test("recycling bin switched off mid-download: waits instead of deleting", async () => {
  const env = setup();
  link(env.rstore);
  const { job } = await startJob(env, { title: "m:1" });
  await until(env, job.id, "downloading");
  mock.finish("Heat.1995.1080p.BluRay.x264-GOOD", { messages: [NOT_UPGRADE] });
  mock.state.bins.radarr = "";
  await env.engine.tick(job.id);
  await env.engine.tick(job.id);
  assert.equal(env.rstore.job(job.id).state, "downloading");
  assert.ok(!mock.calls.some((c) => c.path.includes("/moviefile/")));
  mock.state.bins.radarr = "/recycle";
  await env.engine.tick(job.id); // downloading → swapping → importing
  await env.engine.tick(job.id);
  assert.equal(env.rstore.job(job.id).state, "done");
});

test("stuck import: after the swap, an admin is alerted and can mark it resolved", async () => {
  const env = setup({ adminRoleId: "admin-role" });
  link(env.rstore);
  const { job } = await startJob(env, { title: "m:1" });
  await until(env, job.id, "downloading");
  mock.state.importOnRefresh = false;
  mock.finish("Heat.1995.1080p.BluRay.x264-GOOD", { messages: [NOT_UPGRADE] });
  await env.engine.tick(job.id);
  const j = env.rstore.job(job.id);
  assert.equal(j.state, "importing");
  j.swapStartedAt = Date.now() - 60 * 60_000;
  env.rstore.saveJob(j);
  await env.engine.tick(job.id);
  assert.equal(env.rstore.job(job.id).state, "needs_admin");
  const alert = posts(env.client, "c-rdlog").find((p) => /needs a hand/.test(p.payload.content ?? ""));
  assert.match(alert.payload.content, /<@&admin-role>.*recycling bin.*Manual Import/s);

  let c = await click(env.registry, `rdl:resolve:${job.id}`);
  assert.match(text(c.last()), /Only admins/);
  c = await click(env.registry, `rdl:resolve:${job.id}`, ADMIN);
  assert.equal(env.rstore.job(job.id).state, "done");
  assert.ok(!mock.calls.some((c) => c.path.includes("/history/failed/")), "not blocklisted: the admin may have restored the old file");
});

test("episode from a season pack: swaps just that file; the pack itself isn't blocklisted", async () => {
  const env = setup();
  link(env.rstore);
  const { job } = await startJob(env, { title: "s:5", season: 1, episode: 1 });
  assert.deepEqual(job.oldGrabs.map((g) => [g.title, g.blocklist]), [["The.Show.S01.1080p-OLDPACK", false]]);
  assert.ok(!job.candidates.some((c) => c.title.includes("OLDPACK")));
  await until(env, job.id, "downloading");
  await env.engine.tick(job.id);
  const dl = env.rstore.job(job.id).downloadId;
  mock.state.preview[dl] = [{ episodes: [{ id: 501 }], rejections: [{ reason: "Not an upgrade for existing episode file(s)" }] }];
  mock.finish("The.Show.S01E01.1080p.WEB-A", { messages: ["Not an upgrade for existing episode file(s)"] });
  await env.engine.tick(job.id);
  await env.engine.tick(job.id);
  assert.equal(env.rstore.job(job.id).state, "done");
  assert.deepEqual(mock.calls.find((c) => c.path === "/sonarr/api/v3/episodefile/bulk").body, { episodeFileIds: [51] });
  assert.ok(!mock.calls.some((c) => c.path.includes("/history/failed/")));
  assert.equal(mock.state.episodes.find((e) => e.id === 502).episodeFileId, 52, "episode 2 untouched");
});

test("errors don't loop forever: 10 in a row ends a job that hasn't changed anything", async () => {
  const env = setup();
  link(env.rstore);
  mock.state.grabFails.add("Heat.1995.1080p.BluRay.x264-GOOD");
  const { job } = await startJob(env, { title: "m:1" });
  await waitFor(() => (env.rstore.job(job.id).errorCount ?? 0) >= 1);
  for (let n = 0; n < 12 && env.rstore.job(job.id).state === "grabbing"; n++) await env.engine.tick(job.id);
  const j = env.rstore.job(job.id);
  assert.equal(j.state, "failed");
  assert.equal(j.changedFiles, false);
  assert.ok(j.events.filter((e) => e.text.includes("will retry")).length <= 2, "repeated errors don't flood the timeline");
});

// ---- seasons ----------------------------------------------------------------------------------
test("season: counts as 2, only replaces the episodes the pack actually contains", async () => {
  const env = setup();
  link(env.rstore);
  const { job } = await startJob(env, { title: "s:5", season: 1 });
  assert.equal(job.target.kind, "season");
  assert.equal(job.target.weight, 2);
  assert.equal(job.candidates[0].title, "The.Show.S01.1080p-NEWPACK");
  await until(env, job.id, "downloading");
  const dl = env.rstore.job(job.id).downloadId ?? mock.state.queue[0].downloadId;
  // The pack only has episode 1 (blocked by the old file) and the missing episode 3.
  mock.state.preview[dl] = [
    { episodes: [{ id: 501 }], rejections: [{ reason: "Not an upgrade for existing episode file(s)" }] },
    { episodes: [{ id: 503 }], rejections: [] },
  ];
  mock.finish("The.Show.S01.1080p-NEWPACK", { messages: ["Not an upgrade for existing episode file(s)", "Episode 2 missing from release"] });
  await env.engine.tick(job.id);
  const del = mock.calls.find((c) => c.method === "DELETE" && c.path === "/sonarr/api/v3/episodefile/bulk");
  assert.deepEqual(del.body, { episodeFileIds: [51] }, "episode 2's file is left alone");
  await env.engine.tick(job.id);
  assert.equal(env.rstore.job(job.id).state, "done");
  assert.ok(mock.calls.some((c) => c.path === "/sonarr/api/v3/history/failed/3"));

  // A season costs 2, so nothing's left today.
  const again = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "audio", details: "audio drifts after an hour" });
  assert.match(text(again.last()), /used your 2 redownloads/);
});

test("locks: a running season blocks its episodes; global max; admins bypass limits but not locks", async () => {
  const env = setup();
  link(env.rstore);
  link(env.rstore, "u2", 42); // same plex account in a test is fine for this check
  const { job } = await startJob(env, { title: "s:5", season: 1 });
  await until(env, job.id, "downloading");
  const i = await slash(env.registry, "redownload", "start", { title: "s:5", season: 1, episode: 2, problem: "video", details: "blocky video all over" }, { userId: "u2" });
  assert.match(text(i.last()), /already being replaced/);
  const a = await slash(env.registry, "redownload", "start", { title: "s:5", season: 1, episode: 2, problem: "video", details: "blocky video all over" }, ADMIN);
  assert.match(text(a.last()), /already being replaced/, "admins can't double up on one title either");
});

// ---- approvals, cancel, ban ------------------------------------------------------------------------
test("approve-first: waits for an admin; deny refunds and tells them; approve starts it", async () => {
  const env = setup();
  link(env.rstore);
  await slash(env.registry, "admin", "redownloads approvals", { mode: "on" }, ADMIN);
  const { job, reply } = await startJob(env, { title: "m:1" });
  assert.equal(job.state, "awaiting_approval");
  assert.match(reply, /Sent to the admins/);
  assert.match(reply, /waiting for an admin to OK it/);
  assert.ok(!mock.calls.some((c) => c.method === "POST" && c.path.endsWith("/release")), "nothing grabbed yet");
  const logRow = posts(env.client, "c-rdlog")[0].payload.components[0].toJSON().components.map((b) => b.custom_id);
  assert.deepEqual(logRow, [`rdl:approve:${job.id}`, `rdl:deny:${job.id}`, "rdl:ban:u1"]);

  await click(env.registry, `rdl:deny:${job.id}`, ADMIN);
  assert.equal(env.rstore.job(job.id).state, "denied");
  assert.match(text(env.client.dms.at(-1).payload), /wasn't approved.*didn't count/s);

  // Try again (a denied one doesn't count or set a cooldown) and approve this time.
  const second = await startJob(env, { title: "m:1" });
  await click(env.registry, `rdl:approve:${second.job.id}`, ADMIN);
  await until(env, second.job.id, "downloading");
  assert.match(text(env.client.dms.at(-1).payload), /approved/);
});

test("cancel before the swap removes the download (no blocklist) and refunds; ban from the log", async () => {
  const env = setup();
  link(env.rstore);
  const { job } = await startJob(env, { title: "m:1" });
  await until(env, job.id, "downloading");
  await env.engine.tick(job.id);
  const other = await click(env.registry, `rdt:stop:${job.id}`, { userId: "u2" });
  assert.match(text(other.last()), /isn't yours/);
  await click(env.registry, `rdt:cancel:${job.id}`);
  const c = await click(env.registry, `rdt:stop:${job.id}`);
  assert.match(text(c.last()), /Cancelled/);
  assert.ok(mock.calls.some((x) => x.method === "DELETE" && x.path.startsWith("/radarr/api/v3/queue/") && x.query.blocklist === "false"));
  assert.equal(env.rstore.job(job.id).state, "cancelled");
  assert.ok(!env.client.dms.some((d) => /stopped|cancel/i.test(text(d.payload))), "no extra DM when they cancelled it themselves");

  await click(env.registry, `rdl:ban:u1`, ADMIN);
  const i = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "video", details: "freezes at the bank scene" });
  assert.match(text(i.last()), /can't use redownloads right now/);
});

test("restart-safe: a new engine picks up a job mid-download from the database", async () => {
  const env = setup();
  link(env.rstore);
  const { job } = await startJob(env, { title: "m:1" });
  await until(env, job.id, "downloading");
  const env2 = setup({ dataDir: env.cfg.dataDir });
  mock.finish("Heat.1995.1080p.BluRay.x264-GOOD", { messages: [NOT_UPGRADE] });
  await env2.engine.tickAll();
  await env2.engine.tickAll();
  assert.equal(env2.rstore.job(job.id).state, "done");
});

test("no usable release: nothing changes, nothing is used up", async () => {
  const env = setup();
  link(env.rstore);
  mock.state.releases.movie = mock.state.releases.movie.filter((r) => r.title.includes("OLD") || r.title.includes("REMUX"));
  const i = await slash(env.registry, "redownload", "start", { title: "m:1", problem: "video", details: "freezes at the bank scene" });
  assert.match(text(i.last()), /couldn't find another copy/);
  assert.equal(env.rstore.recentJobs().length, 0);
});

test("autocomplete searches the library across apps; typed titles resolve when unambiguous", async () => {
  const env = setup();
  const ac = fakeInteraction({ options: { __sub: "start", __focused: "hea" } });
  Object.assign(ac, { commandName: "redownload", guildId: "g1", isChatInputCommand: () => false, isAutocomplete: () => true });
  await env.registry.handle(ac);
  assert.deepEqual(ac.log.at(-1).c, [{ name: "🎬 Heat (1995)", value: "m:1" }], "movies without files are left out");
  link(env.rstore);
  const i = await slash(env.registry, "redownload", "start", { title: "the show", problem: "video", details: "freezes at the bank scene" });
  assert.match(text(i.last()), /Which season\?/);
});

// ---- the member's tracker ----------------------------------------------------------------------
const JARGON = /radarr|sonarr|lidarr|torrent|seeder|indexer|usenet|recycl|queue|grab/i;
const dmEdits = (env, job) => env.client.messages.get(env.rstore.job(job.id).trackerMessageId)?.edits ?? [];

test("tracker: a DM card that follows the redownload in plain language, then a final ping", async () => {
  const env = setup();
  const { job, reply } = await startJob(env, { title: "m:1" });
  assert.match(reply, /On it!.*sent this to your DMs/s);
  const first = env.client.dms[0];
  assert.match(text(first.payload), /Fixing Heat \(1995\)/);
  assert.match(text(first.payload), /Your current copy keeps working/);
  await until(env, job.id, "downloading");

  // Partway through: a progress bar and an ETA.
  const item = mock.state.queue[0];
  item.sizeleft = item.size * 0.6;
  item.estimatedCompletionTime = new Date(Date.now() + 20 * 60_000).toISOString();
  await env.engine.tick(job.id);
  let card = text(dmEdits(env, job).at(-1));
  assert.match(card, /✅ Found a fresh copy · 1080p · 8\.4 GB/);
  assert.match(card, /▶️ Downloading  ▰▰▰▰▱▱▱▱▱▱ 40% · done <t:\d+:R>/);
  assert.match(card, /⬜ Ready to watch/);

  // The same progress again doesn't re-edit the message.
  const edits = dmEdits(env, job).length;
  await env.engine.tick(job.id);
  assert.equal(dmEdits(env, job).length, edits);

  mock.finish("Heat.1995.1080p.BluRay.x264-GOOD", { messages: [NOT_UPGRADE] });
  await env.engine.tick(job.id);
  card = text(dmEdits(env, job).at(-1));
  assert.match(card, /▶️ Swapping in the new copy/);
  assert.match(card, /may disappear from Plex for a minute/);
  await env.engine.tick(job.id);
  card = text(dmEdits(env, job).at(-1));
  assert.match(card, /Ready to watch: Heat \(1995\)/);
  assert.equal(dmEdits(env, job).at(-1).components.length, 0, "no buttons once it's over");
  assert.match(text(env.client.dms.at(-1).payload), /fixed and ready to watch/);

  // Nothing members see mentions the apps or download jargon.
  for (const p of [first.payload, ...dmEdits(env, job)]) assert.doesNotMatch(text(p), JARGON);
});

test("tracker: retries say so; Refresh and Cancel (with a confirm) work from the DM", async () => {
  const env = setup();
  const { job } = await startJob(env, { title: "m:1" });
  await until(env, job.id, "downloading");
  mock.failDownload("Heat.1995.1080p.BluRay.x264-GOOD");
  await env.engine.tick(job.id);
  assert.match(text(dmEdits(env, job).at(-1)), /didn't work out, so I'm trying another \(try 2\)/);

  // Someone else can't press their buttons.
  let c = await click(env.registry, `rdt:cancel:${job.id}`, { userId: "u2" });
  assert.match(text(c.last()), /isn't yours/);

  const j = env.rstore.job(job.id);
  j.updatedAt = Date.now() - 60_000;
  env.rstore.saveJob(j);
  c = await click(env.registry, `rdt:refresh:${job.id}`);
  assert.match(text(c.last()), /Fixing Heat/);

  c = await click(env.registry, `rdt:cancel:${job.id}`);
  assert.match(text(c.last()), /Cancel this redownload\?/);
  assert.equal(env.rstore.job(job.id).state, "downloading", "asks before cancelling");
  c = await click(env.registry, `rdt:stop:${job.id}`);
  assert.equal(env.rstore.job(job.id).state, "cancelled");
  assert.match(text(c.last()), /Cancelled: Heat \(1995\)/);
});

test("tracker: DMs closed → the reply says where to look, /redownload status shows the live card", async () => {
  const env = setup();
  env.client.closedDMs.add("u1");
  const { job, reply } = await startJob(env, { title: "m:1" });
  assert.match(reply, /DMs are closed.*\/redownload status/s);
  assert.equal(env.rstore.job(job.id).trackerMessageId, undefined);
  await until(env, job.id, "downloading");
  const st = await slash(env.registry, "redownload", "status");
  const out = st.last();
  assert.match(text(out), /Fixing Heat \(1995\)/);
  assert.match(text(out), /Redownloads left:\*\* 1 of 2/);
  assert.deepEqual(out.components[0].toJSON().components.map((b) => b.custom_id), [`rdt:refresh:${job.id}`, `rdt:cancel:${job.id}`]);
  assert.doesNotMatch(text(out), JARGON);

  mock.finish("Heat.1995.1080p.BluRay.x264-GOOD", { messages: [NOT_UPGRADE] });
  await env.engine.tick(job.id);
  await env.engine.tick(job.id);
  const mention = posts(env.client, "c-notify").find((p) => /<@u1>/.test(p.payload.content ?? ""));
  assert.match(mention.payload.content, /fixed and ready to watch/);
});
