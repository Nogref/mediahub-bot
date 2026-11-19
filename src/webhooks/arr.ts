/**
 * Radarr / Sonarr / Lidarr → Settings → Connect → Webhook.
 *
 * Imports ("Download") are announced; upgrades are skipped. Radarr/Sonarr
 * imports don't prove Plex has scanned the file yet, so they never ping
 * requesters (Seerr/Tautulli/the reconciler do). A Lidarr import does,
 * because Aurral and Navidrome index the same music folder.
 * Health issues and failures go to the admin channel.
 */
import { keys, str, toInt, type InboundEvent } from "../notify/events.js";

type Img = { coverType?: string; remoteUrl?: string; url?: string };
type Body = Record<string, any>;

function image(images: Img[] | undefined, type: string): string | undefined {
  const img = images?.find((i) => i.coverType === type) ?? images?.[0];
  const u = img?.remoteUrl ?? img?.url;
  return u && /^https?:\/\//.test(u) ? u : undefined;
}

/** Shared handling of the events every *arr app sends. */
function common(app: string, b: Body): InboundEvent[] | undefined {
  const event = str(b.eventType) ?? "";
  switch (event) {
    case "Test":
      return [{ type: "alert", source: app, level: "info", title: `${app} webhook connected`, dedupeKey: `test:${app}:${Date.now()}` }];
    case "Health":
      return [
        {
          type: "alert",
          source: app,
          level: str(b.level)?.toLowerCase() === "error" ? "error" : "warn",
          title: `${app} health issue`,
          message: str(b.message),
          dedupeKey: `${app}:health:${str(b.type) ?? str(b.message)}`,
        },
      ];
    case "HealthRestored":
      return [{ type: "alert", source: app, level: "ok", title: `${app} health issue resolved`, message: str(b.message), dedupeKey: `${app}:healthok:${str(b.type) ?? str(b.message)}` }];
    case "DownloadFailure":
    case "ImportFailure":
    case "ManualInteractionRequired":
      return [
        {
          type: "alert",
          source: app,
          level: "warn",
          title: `${app}: ${event.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`,
          message: str(b.message) ?? str(b.release?.releaseTitle) ?? str(b.downloadInfo?.title),
          dedupeKey: `${app}:${event}:${str(b.downloadId) ?? str(b.message) ?? Date.now()}`,
        },
      ];
    case "ApplicationUpdate":
      return [{ type: "alert", source: app, level: "info", title: `${app} updated`, message: str(b.message), dedupeKey: `${app}:update:${str(b.newVersion)}` }];
    case "Grab":
    case "Rename":
    case "Retag":
    case "MovieAdded":
    case "SeriesAdd":
    case "ArtistAdd":
    case "MovieDelete":
    case "MovieFileDelete":
    case "SeriesDelete":
    case "EpisodeFileDelete":
    case "ArtistDelete":
    case "AlbumDelete":
      return [];
    default:
      return undefined; // app-specific, handled by caller
  }
}

export function parseRadarr(b: Body): InboundEvent[] {
  const handled = common("Radarr", b);
  if (handled) return handled;
  if (b.eventType !== "Download" || b.isUpgrade) return [];
  const m = b.movie ?? {};
  const title = str(m.title) ?? "Unknown movie";
  const tmdbId = toInt(m.tmdbId);
  const year = toInt(m.year);
  return [
    {
      type: "media",
      source: "Radarr",
      kind: "movie",
      title,
      year,
      overview: str(m.overview),
      imageUrl: image(m.images, "poster"),
      match: { kind: "movie", tmdbId },
      confirms: false,
      dedupeKey: keys.movie(tmdbId, title, year),
    },
  ];
}

export function parseSonarr(b: Body): InboundEvent[] {
  const handled = common("Sonarr", b);
  if (handled) return handled;
  if (b.eventType !== "Download" || b.isUpgrade) return [];
  const s = b.series ?? {};
  const show = str(s.title) ?? "Unknown show";
  const eps: Body[] = Array.isArray(b.episodes) ? b.episodes : [];
  return eps.map((e) => ({
    type: "media" as const,
    source: "Sonarr",
    kind: "episode" as const,
    title: show,
    groupTitle: show,
    subtitle: str(e.title),
    season: toInt(e.seasonNumber),
    episode: toInt(e.episodeNumber),
    imageUrl: image(s.images, "poster"),
    confirms: false,
    dedupeKey: keys.episode(show, toInt(e.seasonNumber), toInt(e.episodeNumber)),
  }));
}

export function parseLidarr(b: Body): InboundEvent[] {
  const handled = common("Lidarr", b);
  if (handled) return handled;
  // Older Lidarr builds called the album import "AlbumDownload".
  if ((b.eventType !== "Download" && b.eventType !== "AlbumDownload") || b.isUpgrade) return [];
  const album = b.album ?? b.albums?.[0];
  if (!album) return [];
  const artist = str(b.artist?.name) ?? str(b.artist?.artistName);
  const title = str(album.title) ?? "Unknown album";
  const mbAlbumId = str(album.mbId) ?? str(album.MBId) ?? str(album.foreignAlbumId);
  return [
    {
      type: "media",
      source: "Lidarr",
      kind: "album",
      title,
      subtitle: artist,
      year: toInt(String(album.releaseDate ?? "").slice(0, 4)),
      overview: str(album.overview),
      imageUrl: image(album.images, "cover") ?? (mbAlbumId ? `https://coverartarchive.org/release-group/${mbAlbumId}/front-250` : undefined),
      match: { kind: "album", mbAlbumId, lidarrAlbumId: toInt(album.id), title, artistName: artist },
      confirms: true,
      dedupeKey: keys.album(artist, title),
    },
  ];
}
