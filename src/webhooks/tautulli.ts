/**
 * Tautulli → Settings → Notification Agents → Webhook, using the JSON body from
 * the README. "Recently added" becomes a media event; server up/down become alerts.
 * Every playback event (play, resume, pause, stop, …) is ignored on purpose.
 */
import { keys, str, toInt, type InboundEvent, type MediaEvent } from "../notify/events.js";

type Body = Record<string, unknown>;

const PLAYBACK = new Set(["play", "resume", "pause", "stop", "buffer", "watched", "error", "intro", "credits", "commercial", "change"]);

export function parseTautulli(body: Body): InboundEvent[] {
  const action = (str(body.action) ?? "").toLowerCase();
  if (PLAYBACK.has(action)) return [];

  switch (action) {
    case "test":
      return [{ type: "alert", source: "Tautulli", level: "info", title: "Tautulli webhook connected", dedupeKey: `test:tautulli:${Date.now()}` }];
    case "intdown":
    case "extdown":
      return [
        {
          type: "alert",
          source: "Tautulli",
          level: "error",
          title: action === "intdown" ? "Plex server is down" : "Plex remote access is down",
          message: action === "intdown" ? "Tautulli lost its connection to Plex." : "Plex can't be reached from outside your network.",
          dedupeKey: `tautulli:${action}`,
        },
      ];
    case "intup":
    case "extup":
      return [
        {
          type: "alert",
          source: "Tautulli",
          level: "ok",
          title: action === "intup" ? "Plex server is back up" : "Plex remote access is back",
          dedupeKey: `tautulli:${action}`,
        },
      ];
    case "pmsupdate":
      return [{ type: "alert", source: "Tautulli", level: "info", title: "A Plex Media Server update is available", dedupeKey: "tautulli:pmsupdate" }];
    case "created":
      return recentlyAdded(body);
    default:
      return [];
  }
}

function recentlyAdded(b: Body): InboundEvent[] {
  const mediaType = (str(b.media_type) ?? "").toLowerCase();
  const year = toInt(b.year);
  const overview = str(b.summary);
  const imageUrl = str(b.poster_url);
  const tmdbId = toInt(b.tmdb_id);
  const tvdbId = toInt(b.tvdb_id);
  const base = { type: "media" as const, source: "Tautulli", overview, imageUrl, year };

  switch (mediaType) {
    case "movie": {
      const title = str(b.title) ?? "Unknown movie";
      return [{ ...base, kind: "movie", title, confirms: true, match: { kind: "movie", tmdbId }, dedupeKey: keys.movie(tmdbId, title, year) }];
    }
    case "show": {
      const title = str(b.show_name) ?? str(b.title) ?? "Unknown show";
      return [{ ...base, kind: "series", title, confirms: true, match: { kind: "tv", tmdbId, tvdbId }, dedupeKey: keys.series({ tmdbId, tvdbId }, title) }];
    }
    case "season": {
      const show = str(b.show_name) ?? "Unknown show";
      const season = toInt(b.season_num);
      const ev: MediaEvent = {
        ...base,
        kind: "season",
        title: show,
        groupTitle: show,
        season,
        confirms: true,
        match: { kind: "tv", tmdbId, tvdbId },
        dedupeKey: keys.season(show, season),
      };
      return [ev];
    }
    case "episode": {
      const show = str(b.show_name) ?? "Unknown show";
      const season = toInt(b.season_num);
      const episode = toInt(b.episode_num);
      // Single episodes don't count as a fulfilled series request, so no ping.
      return [
        {
          ...base,
          kind: "episode",
          title: show,
          groupTitle: show,
          subtitle: str(b.episode_name),
          season,
          episode,
          confirms: false,
          dedupeKey: keys.episode(show, season, episode),
        },
      ];
    }
    case "album": {
      const title = str(b.album_name) ?? str(b.title) ?? "Unknown album";
      const artist = str(b.artist_name);
      return [
        {
          ...base,
          kind: "album",
          title,
          subtitle: artist,
          confirms: true,
          match: { kind: "album", title, artistName: artist },
          dedupeKey: keys.album(artist, title),
        },
      ];
    }
    default:
      // artist/track/clip/photo additions are too noisy to announce.
      return [];
  }
}
