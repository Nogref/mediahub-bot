import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSeerr } from "../dist/webhooks/seerr.js";
import { parseTautulli } from "../dist/webhooks/tautulli.js";
import { parseRadarr, parseSonarr, parseLidarr } from "../dist/webhooks/arr.js";
import { parseAurral } from "../dist/webhooks/aurral.js";
import { episodeRuns, renderSummary, renderSingle, readyLines } from "../dist/notify/render.js";
import { HealthTracker, overall, instantViews } from "../dist/modules/statusBoard.js";
import { inviteIsValid, wizarrDate } from "../dist/services/wizarr.js";
import { normalizeTitle, Store } from "../dist/core/db.js";
import { Notifier } from "../dist/notify/notifier.js";
import { fakeClient, fakeConfig, json } from "./helpers.mjs";

test("Seerr MEDIA_AVAILABLE becomes a confirming movie event", () => {
  const [ev] = parseSeerr({
    notification_type: "MEDIA_AVAILABLE", subject: "The Matrix (1999)", message: "Neo.", image: "https://image.tmdb.org/t/p/w600/x.jpg",
    media: { media_type: "movie", tmdbId: "603", tvdbId: "" }, request: { request_id: "77" },
  });
  assert.equal(ev.type, "media");
  assert.equal(ev.title, "The Matrix");
  assert.equal(ev.year, 1999);
  assert.equal(ev.confirms, true);
  assert.deepEqual(ev.match, { kind: "movie", tmdbId: 603, tvdbId: undefined, seerrRequestId: 77 });
  assert.equal(ev.dedupeKey, "movie:tmdb:603");
  assert.deepEqual(parseSeerr({ notification_type: "MEDIA_AUTO_APPROVED" }), []);
});

test("Tautulli ignores playback and maps recently-added", () => {
  for (const action of ["play", "resume", "pause", "stop", "watched"]) assert.deepEqual(parseTautulli({ action, media_type: "movie", title: "X" }), []);
  const [movie] = parseTautulli({ action: "created", media_type: "movie", title: "Heat", year: "1995", tmdb_id: "949", poster_url: "https://i.imgur.com/p.jpg" });
  assert.equal(movie.dedupeKey, "movie:tmdb:949");
  assert.equal(movie.confirms, true);
  const [ep] = parseTautulli({ action: "created", media_type: "episode", show_name: "Severance", season_num: "2", episode_num: "3", episode_name: "Who Is Alive?" });
  assert.equal(ep.kind, "episode");
  assert.equal(ep.confirms, false, "single episodes never ping requesters");
  const [down] = parseTautulli({ action: "intdown" });
  assert.equal(down.type, "alert");
  assert.equal(down.level, "error");
  // Unfilled TMDB id in Tautulli comes through as an empty string.
  const [noId] = parseTautulli({ action: "created", media_type: "movie", title: "Heat", year: "1995", tmdb_id: "" });
  assert.equal(noId.dedupeKey, "movie:t:heat:1995");
});

test("*arr webhooks: imports announced, upgrades skipped, health → alerts", () => {
  assert.equal(parseRadarr({ eventType: "Download", isUpgrade: false, movie: { title: "Heat", year: 1995, tmdbId: 949 } })[0].dedupeKey, "movie:tmdb:949");
  assert.deepEqual(parseRadarr({ eventType: "Download", isUpgrade: true, movie: { title: "Heat" } }), []);
  assert.deepEqual(parseRadarr({ eventType: "Grab" }), []);
  assert.equal(parseRadarr({ eventType: "Test" })[0].type, "alert");
  const eps = parseSonarr({ eventType: "Download", series: { title: "Severance" }, episodes: [{ seasonNumber: 2, episodeNumber: 1 }, { seasonNumber: 2, episodeNumber: 2 }] });
  assert.equal(eps.length, 2);
  const [alb] = parseLidarr({ eventType: "Download", artist: { name: "Radiohead" }, album: { id: 5, mbId: "rg-1", title: "OK Computer (Remastered)", releaseDate: "1997-05-21T00:00:00Z" } });
  assert.equal(alb.kind, "album");
  assert.equal(alb.confirms, true);
  assert.equal(alb.match.mbAlbumId, "rg-1");
  assert.equal(alb.dedupeKey, "album:radiohead:ok-computer");
  const [health] = parseLidarr({ eventType: "Health", level: "error", message: "Indexers unavailable", type: "IndexerStatusCheck" });
  assert.equal(health.level, "error");
});

test("Aurral request-available matches by artist + album", () => {
  const [ev] = parseAurral({ event: "notifyRequestAvailable", artist: "Radiohead", album: "OK Computer" });
  assert.equal(ev.dedupeKey, "album:radiohead:ok-computer");
  assert.deepEqual(parseAurral({ event: "notifyTrackAdded", artist: "x", track: "y" }), []);
});

test("episode runs collapse consecutive episodes", () => {
  const ev = (s, e) => ({ kind: "episode", season: s, episode: e });
  assert.equal(episodeRuns([ev(1, 3), ev(1, 1), ev(1, 2), ev(1, 5), ev(2, 1)]), "S01E01–E03, S01E05, S02E01");
});

test("summary embed groups by type and shows requesters", () => {
  const items = [
    { event: { kind: "movie", title: "Heat", year: 1995, source: "Radarr", dedupeKey: "a" }, requesters: ["u1"] },
    { event: { kind: "episode", title: "Severance", groupTitle: "Severance", season: 2, episode: 1, source: "Sonarr", dedupeKey: "b" }, requesters: [] },
    { event: { kind: "episode", title: "Severance", groupTitle: "Severance", season: 2, episode: 2, source: "Sonarr", dedupeKey: "c" }, requesters: [] },
    { event: { kind: "album", title: "OK Computer", subtitle: "Radiohead", source: "Lidarr", dedupeKey: "d" }, requesters: [] },
  ];
  const e = json(renderSummary(items));
  assert.match(e.title, /4 new additions/);
  assert.match(e.description, /\*\*🎬 Movies\*\*\n• Heat \(1995\) — requested by <@u1>/);
  assert.match(e.description, /Severance — S02E01–E02 \(2 episodes\)/);
  assert.match(e.description, /OK Computer — Radiohead/);
  assert.match(readyLines(items), /<@u1> — \*\*Heat \(1995\)\*\* is ready on Plex/);
  const single = json(renderSingle(items[0]));
  assert.equal(single.fields[0].value, "<@u1>");
});

test("health tracker debounces down and reports recovery once", () => {
  const persisted = [];
  const t = new HealthTracker(2, 2000, new Map([["lidarr", { up: true, changedAt: 0 }]]), (k, up) => persisted.push([k, up]));
  const fail = [{ key: "lidarr", name: "Lidarr", ok: false, latencyMs: 5000, error: "timeout" }];
  const ok = [{ key: "lidarr", name: "Lidarr", ok: true, latencyMs: 30 }];
  let r = t.evaluate(fail, 1000);
  assert.equal(r.views[0].state, "flaky");
  assert.equal(r.transitions.length, 0);
  r = t.evaluate(fail, 2000);
  assert.equal(r.views[0].state, "down");
  assert.deepEqual(r.transitions, [{ name: "Lidarr", up: false, error: "timeout" }]);
  r = t.evaluate(fail, 3000);
  assert.equal(r.transitions.length, 0, "no repeat while still down");
  r = t.evaluate(ok, 62_000);
  assert.equal(r.transitions[0].up, true);
  assert.equal(r.transitions[0].downForMs, 60_000);
  assert.deepEqual(persisted, [["lidarr", false], ["lidarr", true]]);
  assert.match(overall(instantViews([{ key: "a", name: "A", ok: true, latencyMs: 3000 }], 2000)).summary, /Degraded/);
});

test("first-ever check of a down service sets state without a heads-up", () => {
  const t = new HealthTracker(1, 2000, new Map(), () => {});
  const r = t.evaluate([{ key: "x", name: "X", ok: false, latencyMs: 1, error: "e" }]);
  assert.equal(r.views[0].state, "down");
  assert.equal(r.transitions.length, 0);
});

test("Wizarr validity: naive timestamps are UTC, unlimited used invites stay valid", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  assert.equal(wizarrDate("2026-11-19T13:00:00"), Date.parse("2026-11-19T13:00:00Z"));
  assert.equal(inviteIsValid({ status: "pending", expires: "2026-11-19T11:00:00" }, now), false);
  assert.equal(inviteIsValid({ status: "pending", expires: null }, now), true);
  assert.equal(inviteIsValid({ status: "used", unlimited: false }, now), false);
  assert.equal(inviteIsValid({ status: "used", unlimited: true }, now), true);
});

test("normalizeTitle strips edition noise", () => {
  assert.equal(normalizeTitle("OK Computer (Remastered 2009)"), "ok computer");
  assert.equal(normalizeTitle("Beyoncé & Jay-Z"), "beyonce and jay z");
});

test("notifier: batches per channel, dedupes across sources, pings requester once confirmed", async () => {
  const cfg = fakeConfig();
  const store = new Store(cfg.dataDir);
  const client = fakeClient();
  const n = new Notifier(client, store, cfg);
  store.addRequest({ discordUserId: "u1", kind: "movie", target: "seerr", title: "The Matrix", tmdbId: 603 });

  // Radarr import: announced, but not a Plex confirmation → no ping yet.
  n.publish(parseRadarr({ eventType: "Download", movie: { title: "The Matrix", year: 1999, tmdbId: 603 } }));
  n.publish(parseSonarr({ eventType: "Download", series: { title: "Severance" }, episodes: [{ seasonNumber: 2, episodeNumber: 1 }] }));
  n.publish(parseLidarr({ eventType: "Health", level: "warning", message: "Disk low", type: "Disk" }));
  await n.flush("c-notify");
  await n.flush("c-admin");
  assert.equal(client.sent.length, 2);
  const media = client.sent.find((s) => s.channelId === "c-notify").payload;
  assert.equal(media.content, undefined);
  assert.match(json(media.embeds[0]).title, /2 new additions/);
  assert.equal(store.pendingRequests().length, 1);
  const alert = client.sent.find((s) => s.channelId === "c-admin").payload;
  assert.match(json(alert.embeds[0]).title, /Lidarr health issue/);

  // Seerr says it's available: already announced, so only the mention goes out.
  n.publish(parseSeerr({ notification_type: "MEDIA_AVAILABLE", subject: "The Matrix (1999)", media: { media_type: "movie", tmdbId: "603" }, request: { request_id: "77" } }));
  await n.flush("c-notify");
  const ping = client.sent[2].payload;
  assert.equal(ping.embeds.length, 0);
  assert.match(ping.content, /<@u1> — \*\*The Matrix \(1999\)\*\* is ready on Plex/);
  assert.deepEqual(ping.allowedMentions, { users: ["u1"], roles: [], parse: [] });
  assert.equal(store.pendingRequests().length, 0, "request marked notified");

  // Same event again: nothing left to say.
  n.publish(parseSeerr({ notification_type: "MEDIA_AVAILABLE", subject: "The Matrix (1999)", media: { media_type: "movie", tmdbId: "603" } }));
  await n.flush("c-notify");
  assert.equal(client.sent.length, 3);
  n.stop();
  store.close();
});

test("music queue: next, cap, radio cleanup, shuffle", async () => {
  const { TrackQueue, MAX_QUEUE, fmtDuration } = await import("../dist/music/queue.js");
  const t = (id, radio = false) => ({ song: { id, title: id, duration: 60 }, requestedBy: "x", radio });
  const q = new TrackQueue();
  q.add([t("a"), t("b")]);
  q.add([t("n")], true);
  assert.deepEqual(q.list().map((x) => x.song.id), ["n", "a", "b"]);
  q.add([t("r1", true), t("r2", true)]);
  q.clearRadio();
  assert.equal(q.length, 3);
  assert.equal(q.duration(), 180);
  const big = Array.from({ length: MAX_QUEUE + 10 }, (_, i) => t(`x${i}`));
  assert.equal(q.add(big), MAX_QUEUE - 3);
  let k = 0;
  q.shuffle(() => (k++ % 7) / 7);
  assert.equal(q.length, MAX_QUEUE);
  assert.equal(fmtDuration(387), "6:27");
  assert.equal(fmtDuration(3725), "1:02:05");
});

test("Seerr issue webhooks: created → admin alert, resolved → issue event", () => {
  const [created] = parseSeerr({ notification_type: "ISSUE_CREATED", subject: "Heat (1995)", message: "No sound", issue: { issue_id: "4", issue_type: "AUDIO", reportedBy_username: "sam" } });
  assert.equal(created.type, "alert");
  assert.match(created.title, /New audio issue: Heat \(1995\)/);
  assert.equal(created.dedupeKey, "seerr:issue:4");
  const [resolved] = parseSeerr({ notification_type: "ISSUE_RESOLVED", issue: { issue_id: "4" } });
  assert.deepEqual({ type: resolved.type, action: resolved.action, issueId: resolved.issueId }, { type: "issue", action: "resolved", issueId: 4 });
});
