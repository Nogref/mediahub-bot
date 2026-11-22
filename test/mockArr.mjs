// A stateful fake of Radarr, Sonarr, plex.tv and a Plex server, enough to run
// redownloads end to end: grabs, queue states, imports, deletes, history.
import http from "node:http";

const q = (name) => ({ quality: { name } });

export function freshState() {
  return {
    bins: { radarr: "/recycle", sonarr: "/recycle" },
    importOnRefresh: true,
    nextId: 1000,
    queue: [],
    history: [
      { id: 1, eventType: "grabbed", date: "2024-01-01T00:00:00Z", sourceTitle: "Heat.1995.1080p.BluRay.x264-OLD", downloadId: "OLDHASH", movieId: 1 },
      { id: 2, eventType: "downloadFolderImported", date: "2024-01-01T01:00:00Z", sourceTitle: "Heat.1995.1080p.BluRay.x264-OLD", downloadId: "OLDHASH", movieId: 1 },
      // A season pack: Sonarr writes one record per episode.
      { id: 3, eventType: "grabbed", date: "2024-01-01T00:00:00Z", sourceTitle: "The.Show.S01.1080p-OLDPACK", downloadId: "OLDPACK", seriesId: 5, seasonNumber: 1, episodeId: 501 },
      { id: 5, eventType: "grabbed", date: "2024-01-01T00:00:00Z", sourceTitle: "The.Show.S01.1080p-OLDPACK", downloadId: "OLDPACK", seriesId: 5, seasonNumber: 1, episodeId: 502 },
      { id: 4, eventType: "downloadFolderImported", date: "2024-01-01T01:00:00Z", sourceTitle: "The.Show.S01.1080p-OLDPACK", downloadId: "OLDPACK", seriesId: 5, seasonNumber: 1, episodeId: 501 },
      { id: 6, eventType: "downloadFolderImported", date: "2024-01-01T01:00:00Z", sourceTitle: "The.Show.S01.1080p-OLDPACK", downloadId: "OLDPACK", seriesId: 5, seasonNumber: 1, episodeId: 502 },
    ],
    movies: [
      {
        id: 1, title: "Heat", year: 1995, tmdbId: 949, hasFile: true, images: [{ coverType: "poster", remoteUrl: "https://img.example/heat.jpg" }],
        movieFile: { id: 10, quality: q("Bluray-1080p"), size: 8e9, sceneName: "Heat.1995.1080p.BluRay.x264-OLD" },
      },
      { id: 2, title: "Alien", year: 1979, tmdbId: 348, hasFile: false, monitored: true, isAvailable: true, images: [] },
      { id: 3, title: "Future Film", year: 2027, tmdbId: 999, hasFile: false, monitored: true, isAvailable: false, digitalRelease: "2027-06-01T00:00:00Z" },
    ],
    series: [
      { id: 5, title: "The Show", year: 2020, tvdbId: 77, statistics: { episodeFileCount: 2, episodeCount: 5 }, images: [] },
      { id: 6, title: "Complete Show", year: 2019, tvdbId: 78, statistics: { episodeFileCount: 1, episodeCount: 1 }, images: [] },
    ],
    episodes: [
      { id: 501, seriesId: 5, seasonNumber: 1, episodeNumber: 1, title: "Pilot", hasFile: true, episodeFileId: 51, airDateUtc: "2020-01-01T00:00:00Z" },
      { id: 502, seriesId: 5, seasonNumber: 1, episodeNumber: 2, title: "Two", hasFile: true, episodeFileId: 52, airDateUtc: "2020-01-08T00:00:00Z" },
      { id: 503, seriesId: 5, seasonNumber: 1, episodeNumber: 3, title: "Three", hasFile: false, episodeFileId: 0, airDateUtc: "2020-01-15T00:00:00Z" },
      { id: 504, seriesId: 5, seasonNumber: 1, episodeNumber: 4, title: "TBA", hasFile: false, episodeFileId: 0, airDateUtc: "2099-01-01T00:00:00Z" },
      { id: 601, seriesId: 5, seasonNumber: 2, episodeNumber: 1, title: "New Start", hasFile: false, episodeFileId: 0, airDateUtc: "2021-01-01T00:00:00Z" },
      { id: 602, seriesId: 5, seasonNumber: 2, episodeNumber: 2, title: "Lost One", hasFile: false, episodeFileId: 0, airDateUtc: "2021-01-08T00:00:00Z" },
      { id: 701, seriesId: 6, seasonNumber: 1, episodeNumber: 1, title: "Only", hasFile: true, episodeFileId: 71, airDateUtc: "2019-01-01T00:00:00Z" },
    ],
    episodeFiles: [
      { id: 51, seriesId: 5, seasonNumber: 1, quality: q("WEBDL-1080p"), size: 2e9, sceneName: "The.Show.S01.1080p-OLDPACK" },
      { id: 52, seriesId: 5, seasonNumber: 1, quality: q("WEBDL-1080p"), size: 2e9, sceneName: "The.Show.S01.1080p-OLDPACK" },
    ],
    releases: {
      movie: [
        rel("Heat.1995.2160p.REMUX-BIG", 20, 60e9, 80, ["Not wanted in profile"]),
        rel("Heat.1995.1080p.BluRay.x264-OLD", 10, 8e9, 90),
        rel("Heat.1995.1080p.BluRay.x264-GOOD", 10, 9e9, 50),
        rel("Heat.1995.1080p.WEB-DL-OK", 9, 6e9, 20),
        rel("Heat.1995.Sample-TINY", 10, 100e6, 99),
        rel("Heat.1995.1080p.DEAD", 10, 8e9, 0),
        rel("Heat.1995.720p.BluRay-SMALLER", 5, 4e9, 5),
      ],
      episode: [
        rel("The.Show.S01E01.1080p.WEB-A", 10, 2e9, 30),
        rel("The.Show.S01E01.1080p.WEB-B", 10, 2e9, 10),
        rel("The.Show.S01E01.720p.WEB-C", 5, 1e9, 10),
        rel("The.Show.S01E01.720p.WEB-D", 5, 1e9, 4),
        { ...rel("The.Show.S01.1080p-PACK", 10, 6e9, 40), fullSeason: true },
      ],
      season: [
        { ...rel("The.Show.S01.1080p-NEWPACK", 10, 6e9, 40), fullSeason: true },
        rel("The.Show.S01E01.1080p.WEB-A", 10, 2e9, 30),
      ],
    },
    /** What a search finds: episode id / movie id → release title (missing = nothing out there). */
    findable: { episodes: {}, packs: {}, movies: {} },
    /** What an interactive search shows for a missing item (releases outside the profile carry quality rejections). */
    fallback: { episodes: {}, seasons: {}, movies: {} },
    tags: [],
    tagged: [],
    monitored: [],
    commands: [],
    /** Files the next import preview reports for a downloadId (Sonarr). */
    preview: {},
    grabFails: new Set(),
    pinToken: undefined,
    sharedUsersXml:
      '<MediaContainer><User id="42" title="alice" username="alice"><Server id="9" machineIdentifier="abc123" name="Home"/></User>' +
      '<User id="43" title="bob" username="bob"><Server machineIdentifier="someoneelse"/></User></MediaContainer>',
    accounts: { t: { id: 1, username: "owner" }, alicetoken: { id: 42, username: "alice" }, bobtoken: { id: 43, username: "bob" } },
  };
}

function rel(title, qualityWeight, size, seeders, rejections) {
  return {
    guid: `guid-${title}`,
    indexerId: 3,
    indexer: "TestIndexer",
    title,
    quality: q(qualityWeight >= 10 ? "Bluray-1080p" : "Bluray-720p"),
    qualityWeight,
    customFormatScore: 0,
    size,
    protocol: "torrent",
    seeders,
    ageMinutes: 1000,
    rejections: rejections ?? ["Existing file on disk is of equal or higher preference: Bluray-1080p"],
  };
}

export async function startArrMock() {
  const calls = [];
  let s = freshState();

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://x");
    const parsed = body && req.headers["content-type"]?.includes("json") ? JSON.parse(body) : undefined;
    const p = url.pathname;
    const m = req.method;
    const qp = Object.fromEntries(url.searchParams);
    calls.push({ method: m, path: p, query: qp, body: parsed, headers: req.headers });
    const send = (status, data, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(data === undefined ? "" : type === "application/json" ? JSON.stringify(data) : data);
    };

    // ---- plex.tv + Plex ----
    if (p === "/plextv/api/v2/pins" && m === "POST") return send(201, { id: 7, code: "PINCODE" });
    if (p === "/plextv/api/v2/pins/7") return send(200, { id: 7, authToken: s.pinToken ?? null });
    if (p === "/plextv/users/account.json") {
      const a = s.accounts[req.headers["x-plex-token"]];
      return a ? send(200, { user: a }) : send(401, { error: "bad token" });
    }
    if (p === "/plextv/api/users") return send(200, s.sharedUsersXml, "application/xml");
    if (p === "/plex/identity") return send(200, { MediaContainer: { machineIdentifier: "abc123" } });

    const app = p.startsWith("/radarr/") ? "radarr" : p.startsWith("/sonarr/") ? "sonarr" : undefined;
    if (!app) return send(404, { message: "nope" });
    if (req.headers["x-api-key"] !== "rk") return send(401, { message: "Unauthorized" });
    const r = p.replace(/^\/(radarr|sonarr)\/api\/v3/, "");

    if (r === "/config/mediamanagement") return send(200, { recycleBin: s.bins[app] ?? "" });

    // grabbing
    if (r === "/release" && m === "POST") {
      const fb = [...Object.values(s.fallback.episodes), ...Object.values(s.fallback.seasons), ...Object.values(s.fallback.movies)].flat();
      const all = [...s.releases.movie, ...s.releases.episode, ...s.releases.season, ...fb];
      const found = all.find((x) => x.guid === parsed.guid);
      if (!found) return send(404, { message: "Couldn't find requested release in cache" });
      if (s.grabFails.has(found.title)) return send(500, { message: "Download client unavailable" });
      if (found._episodeIds || found._movieId) {
        const ep = found._episodeIds && s.episodes.find((e) => e.id === found._episodeIds[0]);
        grab(app, found.title, ep ?? {}, found._episodeIds ?? [found._movieId]);
        return send(200, found);
      }
      const downloadId = `DL${s.nextId++}`;
      const base = app === "radarr" ? { movieId: 1 } : { seriesId: 5, seasonNumber: 1 };
      s.history.push({ id: s.nextId++, eventType: "grabbed", date: new Date().toISOString(), sourceTitle: found.title, downloadId, ...base });
      s.queue.push({
        id: s.nextId++, app, downloadId, title: found.title, ...base,
        trackedDownloadState: "downloading", trackedDownloadStatus: "ok", status: "downloading", statusMessages: [], size: found.size, sizeleft: found.size / 2,
      });
      return send(200, found);
    }
    if (r === "/release" && m === "GET") {
      if (app === "radarr" && s.fallback.movies[qp.movieId]) return send(200, s.fallback.movies[qp.movieId]);
      if (app === "sonarr" && qp.episodeId && s.fallback.episodes[qp.episodeId]) return send(200, s.fallback.episodes[qp.episodeId]);
      if (app === "sonarr" && !qp.episodeId && s.fallback.seasons[`${qp.seriesId}:${qp.seasonNumber}`]) return send(200, s.fallback.seasons[`${qp.seriesId}:${qp.seasonNumber}`]);
      if (app === "radarr") return send(200, qp.movieId === "1" ? s.releases.movie : []);
      return send(200, qp.episodeId ? s.releases.episode : s.releases.season);
    }
    if (r === "/queue/details") {
      return send(200, s.queue.filter((x) => x.app === app && (!qp.movieId || x.movieId === Number(qp.movieId)) && (!qp.seriesId || x.seriesId === Number(qp.seriesId))));
    }
    if (r.startsWith("/queue/") && m === "DELETE") {
      const id = Number(r.split("/")[2]);
      s.queue = s.queue.filter((x) => x.id !== id);
      return send(200, {});
    }
    if (r === "/history/movie" || r === "/history/series") {
      return send(200, s.history.filter((h) => (app === "radarr" ? h.movieId === Number(qp.movieId) : h.seriesId === Number(qp.seriesId))));
    }
    if (r.startsWith("/history/failed/") && m === "POST") return send(200, {});
    if (r === "/command" && m === "POST") {
      if (parsed.name === "RefreshMonitoredDownloads" && s.importOnRefresh) importBlocked(app);
      const id = s.nextId++;
      s.commands.push({ id, ...parsed });
      runSearch(app, parsed);
      return send(201, { id, name: parsed.name, status: "queued" });
    }
    if (r.startsWith("/command/") && m === "GET") return send(200, { id: Number(r.split("/")[2]), status: s.commandStatus ?? "completed" });
    if (r === "/episode/monitor" && m === "PUT") {
      s.monitored.push(...parsed.episodeIds);
      for (const e of s.episodes) if (parsed.episodeIds.includes(e.id)) e.monitored = parsed.monitored;
      return send(202, {});
    }
    if (r === "/movie/editor" && m === "PUT") {
      if (parsed.monitored !== undefined) s.monitored.push(...parsed.movieIds.map((id) => `m${id}`));
      if (parsed.tags) s.tagged.push({ app, movieIds: parsed.movieIds, tags: parsed.tags, applyTags: parsed.applyTags });
      return send(202, {});
    }
    if (r === "/series/editor" && m === "PUT") {
      s.tagged.push({ app, seriesIds: parsed.seriesIds, tags: parsed.tags, applyTags: parsed.applyTags });
      return send(202, {});
    }
    if (r === "/tag" && m === "GET") return send(200, s.tags.filter((t) => t.app === app));
    if (r === "/tag" && m === "POST") {
      const t = { id: s.nextId++, label: parsed.label, app };
      s.tags.push(t);
      return send(201, t);
    }

    // Radarr library
    if (r === "/movie") return send(200, qp.tmdbId ? s.movies.filter((x) => x.tmdbId === Number(qp.tmdbId)) : s.movies);
    if (r.startsWith("/movie/")) {
      const mv = s.movies.find((x) => x.id === Number(r.split("/")[2]));
      return mv ? send(200, mv) : send(404, { message: "NotFound" });
    }
    if (r.startsWith("/moviefile/") && m === "DELETE") {
      const mv = s.movies.find((x) => x.movieFile?.id === Number(r.split("/")[2]));
      if (mv) {
        mv.movieFile = undefined;
        mv.hasFile = false;
      }
      return send(200, {});
    }
    if (r === "/manualimport") return send(200, s.preview[qp.downloadId] ?? []);

    // Sonarr library
    if (r === "/series") return send(200, qp.tvdbId ? s.series.filter((x) => x.tvdbId === Number(qp.tvdbId)) : s.series);
    if (r.startsWith("/series/")) return send(200, s.series.find((x) => x.id === Number(r.split("/")[2])));
    if (r === "/episode") return send(200, s.episodes.filter((e) => e.seriesId === Number(qp.seriesId) && (qp.seasonNumber === undefined || e.seasonNumber === Number(qp.seasonNumber))));
    if (r === "/episodefile") return send(200, s.episodeFiles.filter((f) => f.seriesId === Number(qp.seriesId)));
    if (r === "/episodefile/bulk" && m === "DELETE") {
      const ids = new Set(parsed.episodeFileIds);
      s.episodeFiles = s.episodeFiles.filter((f) => !ids.has(f.id));
      for (const e of s.episodes) if (ids.has(e.episodeFileId)) Object.assign(e, { hasFile: false, episodeFileId: 0 });
      return send(200, {});
    }
    return send(404, { message: `mock: no route ${m} ${p}` });
  });

  /** What a search command does: grab whatever "findable" says is out there. */
  function grab(app, title, base, itemIds) {
    const downloadId = `DL${s.nextId++}`;
    for (const itemId of itemIds) {
      const ids = app === "radarr" ? { movieId: itemId } : { seriesId: base.seriesId, seasonNumber: base.seasonNumber, episodeId: itemId };
      s.history.push({ id: s.nextId++, eventType: "grabbed", date: new Date().toISOString(), sourceTitle: title, downloadId, ...ids });
      s.queue.push({ id: s.nextId++, app, downloadId, title, ...ids, trackedDownloadState: "downloading", trackedDownloadStatus: "ok", status: "downloading", statusMessages: [], size: 2e9, sizeleft: 1.5e9 });
    }
  }
  function runSearch(app, cmd) {
    const f = s.findable;
    if (cmd.name === "MoviesSearch") for (const id of cmd.movieIds) if (f.movies[id]) grab(app, f.movies[id], {}, [id]);
    if (cmd.name === "EpisodeSearch") {
      for (const id of cmd.episodeIds) {
        const ep = s.episodes.find((e) => e.id === id);
        if (f.episodes[id]) grab(app, f.episodes[id], ep, [id]);
      }
    }
    if (cmd.name === "SeasonSearch") {
      const pack = f.packs[`${cmd.seriesId}:${cmd.seasonNumber}`];
      const eps = s.episodes.filter((e) => e.seriesId === cmd.seriesId && e.seasonNumber === cmd.seasonNumber && !e.hasFile && e.airDateUtc < new Date().toISOString());
      if (pack) grab(app, pack, { seriesId: cmd.seriesId, seasonNumber: cmd.seasonNumber }, eps.map((e) => e.id));
    }
  }

  /** What the app does on RefreshMonitoredDownloads: retry blocked imports now that the old file is gone. */
  function importBlocked(app) {
    for (const item of s.queue.filter((x) => x.app === app && x.trackedDownloadState === "importBlocked")) {
      if (app === "radarr") {
        const mv = s.movies.find((x) => x.id === item.movieId);
        if (mv.hasFile) continue;
        mv.hasFile = true;
        mv.movieFile = { id: s.nextId++, quality: q("Bluray-1080p"), size: item.size, sceneName: item.title };
      } else {
        const covered = (s.preview[item.downloadId] ?? []).flatMap((x) => x.episodes.map((e) => e.id));
        let any = false;
        for (const id of covered) {
          const ep = s.episodes.find((e) => e.id === id);
          if (ep.hasFile) continue;
          const f = { id: s.nextId++, seriesId: 5, seasonNumber: 1, quality: q("WEBDL-1080p"), size: 2e9, sceneName: item.title };
          s.episodeFiles.push(f);
          Object.assign(ep, { hasFile: true, episodeFileId: f.id });
          any = true;
        }
        if (!any) continue;
      }
      s.queue = s.queue.filter((x) => x !== item);
      s.history.push({ id: s.nextId++, eventType: "downloadFolderImported", date: new Date().toISOString(), sourceTitle: item.title, downloadId: item.downloadId, movieId: item.movieId, seriesId: item.seriesId });
    }
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    get state() {
      return s;
    },
    reset() {
      s = freshState();
      calls.length = 0;
    },
    /** Finish the download for a grabbed release (or the only one in the queue). */
    finish(title, { state = "importBlocked", messages = [] } = {}) {
      const item = s.queue.find((x) => (title ? x.title === title : true));
      if (!item) throw new Error(`mock: nothing queued for ${title}`);
      Object.assign(item, {
        trackedDownloadState: state,
        trackedDownloadStatus: messages.length ? "warning" : "ok",
        status: "completed",
        sizeleft: 0,
        statusMessages: messages.length ? [{ title: "file.mkv", messages }] : [],
      });
      return item;
    },
    /** A missing episode / movie finishes downloading and imports. */
    arrive(itemId, app = "sonarr") {
      if (app === "radarr") {
        const mv = s.movies.find((x) => x.id === itemId);
        Object.assign(mv, { hasFile: true, movieFile: { id: s.nextId++, quality: q("Bluray-1080p"), size: 8e9 } });
        s.queue = s.queue.filter((x) => !(x.app === "radarr" && x.movieId === itemId));
      } else {
        const ep = s.episodes.find((e) => e.id === itemId);
        Object.assign(ep, { hasFile: true, episodeFileId: s.nextId++ });
        s.queue = s.queue.filter((x) => !(x.app === "sonarr" && x.episodeId === itemId));
      }
    },
    failDownload(title) {
      const item = s.queue.find((x) => x.title === title);
      s.queue = s.queue.filter((x) => x !== item);
      s.history.push({ id: s.nextId++, eventType: "downloadFailed", date: new Date().toISOString(), sourceTitle: title, downloadId: item.downloadId, movieId: item.movieId, seriesId: item.seriesId });
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
