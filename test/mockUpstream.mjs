// One HTTP server pretending to be Seerr, Lidarr, Aurral, Wizarr and Plex under path prefixes.
import http from "node:http";

export async function startMock() {
  const calls = [];
  const state = {
    lidarrArtists: [],
    lidarrAlbums: [],
    albumAppearsAfterPolls: 2, // album record shows up a couple of polls after the artist is added
    polls: 0,
    invites: [],
    nextInvite: 5,
    aurralUsers: [{ id: 1, username: "admin", role: "admin" }, { id: 2, username: "taken", role: "user" }],
  };

  const lidarrSearch = [
    { foreignId: "ar-1", artist: { artistName: "Artist A", foreignArtistId: "ar-1" } },
    {
      foreignId: "rg-1",
      album: {
        id: 0, title: "Album One", foreignAlbumId: "rg-1", monitored: false, albumType: "Album",
        releaseDate: "2021-05-01T00:00:00Z", images: [{ coverType: "cover", remoteUrl: "https://img.example/rg-1.jpg" }],
        artist: { artistName: "Artist A", foreignArtistId: "ar-1" },
      },
    },
  ];

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://x");
    const parsed = body ? JSON.parse(body) : undefined;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed, headers: req.headers });
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    const p = url.pathname;
    const m = req.method;

    // ---------------- Seerr
    if (p === "/seerr/api/v1/status") return send(200, { version: "3.0.0" });
    if (p === "/seerr/api/v1/search") {
      return send(200, {
        results: [
          { id: 603, mediaType: "movie", title: "The Matrix", releaseDate: "1999-03-31", posterPath: "/m.jpg", overview: "Neo." },
          { id: 604, mediaType: "movie", title: "The Matrix Reloaded", releaseDate: "2003-05-15", mediaInfo: { status: 5 } },
          { id: 605, mediaType: "movie", title: "The Matrix Revolutions", releaseDate: "2003-11-05", mediaInfo: { status: 3 } },
          { id: 1, mediaType: "person", name: "Keanu" },
          { id: 1399, mediaType: "tv", name: "Game of Thrones", firstAirDate: "2011-04-17" },
        ],
      });
    }
    let mm;
    if ((mm = p.match(/^\/seerr\/api\/v1\/(movie|tv)\/(\d+)$/))) {
      const id = Number(mm[2]);
      if (id === 604) return send(200, { id, title: "The Matrix Reloaded", releaseDate: "2003-05-15", mediaInfo: { id: 12, status: 5 } });
      if (id === 606) {
        return send(200, {
          id, title: "Dune", releaseDate: "2021-10-22",
          mediaInfo: { id: 13, status: 3, downloadStatus: [{ size: 1000, sizeLeft: 250, status: "downloading", estimatedCompletionTime: new Date(Date.now() + 600000).toISOString() }] },
        });
      }
      if (id === 605) return send(200, { id, title: "The Matrix Revolutions", releaseDate: "2003-11-05", mediaInfo: { status: 3, requests: [{ id: 90 }] } });
      return send(200, { id, title: "The Matrix", releaseDate: "1999-03-31", posterPath: "/m.jpg", externalIds: { tvdbId: 121361 } });
    }
    if (p === "/seerr/api/v1/request" && m === "POST") {
      if (parsed.mediaId === 605) return send(409, { message: "Request for this media already exists." });
      return send(201, { id: 77, status: 2, media: { tmdbId: parsed.mediaId } });
    }
    if (p === "/seerr/api/v1/request/77") return send(200, { id: 77, status: 2, media: { status: 5 } });
    if (p === "/seerr/api/v1/issue" && m === "POST") return send(201, { id: 31 });
    if (p === "/seerr/api/v1/issue/31") return send(200, { id: 31, status: state.issueStatus ?? 1 });
    if (p === "/seerr/api/v1/request/count") return send(200, { total: 12, movie: 8, tv: 4, pending: 0, approved: 12 });
    if (p === "/seerr/api/v1/user") return send(200, { results: [{ id: 1 }, { id: 2 }] });
    if (p === "/seerr/api/v1/user/1/settings/notifications") return send(200, { discordIds: [] });
    if (p === "/seerr/api/v1/user/2/settings/notifications") return send(200, { discordIds: ["u1"] });

    // ---------------- Lidarr
    if (p === "/lidarr/api/v1/system/status") return send(200, { version: "2.0" });
    if (p === "/lidarr/api/v1/search") return send(200, lidarrSearch);
    if (p === "/lidarr/api/v1/rootfolder") return send(200, [{ id: 1, path: "/music/" }]);
    if (p === "/lidarr/api/v1/qualityprofile") return send(200, [{ id: 1, name: "Any" }, { id: 2, name: "Lossless" }]);
    if (p === "/lidarr/api/v1/metadataprofile") return send(200, [{ id: 1, name: "Standard" }]);
    if (p === "/lidarr/api/v1/artist" && m === "GET") {
      if (url.searchParams.get("mbId")) return send(200, state.lidarrArtists.filter((a) => a.foreignArtistId === url.searchParams.get("mbId")));
      return send(200, [...state.lidarrArtists, { id: 99, artistName: "Old", monitored: false }]);
    }
    if (p === "/lidarr/api/v1/artist" && m === "POST") {
      const a = { ...parsed, id: 10 };
      state.lidarrArtists.push(a);
      return send(201, a);
    }
    if (p === "/lidarr/api/v1/album" && m === "GET") {
      const fid = url.searchParams.get("foreignAlbumId");
      if (state.lidarrArtists.length && fid === "rg-1") {
        state.polls++;
        if (state.polls >= state.albumAppearsAfterPolls && !state.lidarrAlbums.length) {
          state.lidarrAlbums.push({ id: 55, title: "Album One", foreignAlbumId: "rg-1", artistId: 10, monitored: false, statistics: { trackFileCount: 0, trackCount: 10, totalTrackCount: 10, percentOfTracks: 0 } });
        }
      }
      return send(200, state.lidarrAlbums.filter((a) => a.foreignAlbumId === fid));
    }
    if (p === "/lidarr/api/v1/album/55" && state.lidarrAlbums.some((a) => a.id === 55)) return send(200, state.lidarrAlbums.find((a) => a.id === 55));
    if (p === "/lidarr/api/v1/album/55") return send(200, { id: 55, title: "Album One", foreignAlbumId: "rg-1", statistics: { trackFileCount: 10, trackCount: 10, totalTrackCount: 10, percentOfTracks: 100 } });
    if (p === "/lidarr/api/v1/queue/details") return send(200, url.searchParams.get("albumIds") === "56" ? [{ albumId: 56, size: 100, sizeleft: 40 }] : []);
    if (p === "/lidarr/api/v1/album/56") return send(200, { id: 56, title: "Queued Album", foreignAlbumId: "rg-56", statistics: { trackFileCount: 0, trackCount: 10, totalTrackCount: 10, percentOfTracks: 0 } });
    if (p === "/lidarr/api/v1/album/monitor" && m === "PUT") return send(202, []);
    if (p === "/lidarr/api/v1/command" && m === "POST") return send(201, { id: 1, status: "queued" });

    // ---------------- Aurral
    if (p === "/aurral/api/health/live") { res.writeHead(200); return res.end("ok"); }
    if (p === "/aurral/api/search") {
      return send(200, { scope: "album", items: [{ id: "rg-9", title: "Aurral Album", artistName: "Band B", artistMbid: "ar-9", releaseDate: "2019-01-01", primaryType: "Album", coverUrl: "/api/cover/x" }] });
    }
    if (p === "/aurral/api/library/albums/request" && m === "POST") {
      return send(201, { success: true, status: "queued", album: { id: "lib-1" }, createdArtist: true, queued: true, albumStatus: { status: "queued" } });
    }
    if (p === "/aurral/api/library/albums/lib-1/status") return send(200, { status: state.aurralStatus ?? "complete" });
    if (p === "/aurral/api/users" && m === "GET") return send(200, state.aurralUsers);
    if (p === "/aurral/api/users" && m === "POST") {
      if (state.aurralUsers.some((u) => u.username === parsed.username.toLowerCase())) return send(409, { error: "Username already exists" });
      if ((parsed.password ?? "").length < 8) return send(400, { error: "Password must be at least 8 characters long" });
      const u = { id: state.aurralUsers.length + 10, username: parsed.username.toLowerCase(), role: parsed.role };
      state.aurralUsers.push(u);
      return send(201, u);
    }

    // ---------------- Wizarr
    if (p === "/wizarr/api/status") return send(200, { users: 3 });
    if (p === "/wizarr/api/servers") return send(200, { servers: [{ id: 1, name: "Plex", server_type: "plex", verified: true }, { id: 2, name: "JF", server_type: "jellyfin", verified: true }] });
    if (p === "/wizarr/api/invitations" && m === "GET") return send(200, { invitations: state.invites, count: state.invites.length });
    if (p === "/wizarr/api/invitations" && m === "POST") {
      const id = state.nextInvite++;
      const days = parsed.expires_in_days;
      const inv = {
        id, code: `CODE${id}XYZ`, url: `/j/CODE${id}XYZ`, status: "pending",
        expires: days ? new Date(Date.now() + days * 86400000).toISOString().replace("Z", "") : null,
        unlimited: parsed.unlimited, server_names: ["Plex"],
      };
      state.invites.push(inv);
      return send(201, { message: "ok", invitation: inv });
    }
    if ((mm = p.match(/^\/wizarr\/api\/invitations\/(\d+)$/)) && m === "DELETE") {
      state.invites = state.invites.filter((i) => i.id !== Number(mm[1]));
      return send(200, { message: "deleted" });
    }

    // ---------------- Plex
    if (p === "/plex/identity") return send(200, { MediaContainer: { machineIdentifier: "abc123" } });
    if (p === "/plex/library/sections") return send(200, { MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }, { key: "2", title: "TV", type: "show" }] } });
    if (p === "/plex/library/sections/1/all") {
      if (url.searchParams.get("X-Plex-Container-Size") === "0") return send(200, { MediaContainer: { size: 0, totalSize: 3 } });
      return send(200, { MediaContainer: { Metadata: [{ ratingKey: "42", title: "Heat", year: 1995, summary: "Cops and robbers.", thumb: "/library/metadata/42/thumb/1", duration: 10200000, Genre: [{ tag: "Crime" }] }] } });
    }
    if (p === "/plex/library/sections/2/all") return send(200, { MediaContainer: { size: 0, totalSize: url.searchParams.get("type") === "4" ? 120 : 7 } });
    if (p === "/plex/photo/:/transcode") { res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(Buffer.from([0xff, 0xd8, 0xff])); }

    send(404, { message: `mock: no route for ${m} ${p}` });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, state, close: () => new Promise((r) => server.close(r)) };
}
