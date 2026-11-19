/** The common shape every webhook parser (and the request reconciler) produces. */
import { normalizeTitle, type MatchKeys } from "../core/db.js";

export type MediaKind = "movie" | "series" | "season" | "episode" | "album" | "track";

export interface MediaEvent {
  type: "media";
  /** Who told us: seerr, tautulli, radarr, sonarr, lidarr, aurral, reconciler. */
  source: string;
  kind: MediaKind;
  /** Movie title, show name or album title. */
  title: string;
  /** Episode label ("S01E03 · Pilot"), album artist, etc. */
  subtitle?: string;
  year?: number;
  overview?: string;
  imageUrl?: string;
  /** Show name for episodes/seasons, used to group them in summaries. */
  groupTitle?: string;
  season?: number;
  episode?: number;
  /** Identifiers used to find who requested it. */
  match?: MatchKeys;
  /**
   * True when the event proves the item is watchable/listenable (on Plex or in
   * Aurral) rather than merely downloaded. Only confirming events @-mention requesters.
   */
  confirms: boolean;
  /** Same item from different sources shares a key, so it's only announced once. */
  dedupeKey: string;
}

export interface AlertEvent {
  type: "alert";
  source: string;
  level: "ok" | "info" | "warn" | "error";
  title: string;
  message?: string;
  dedupeKey: string;
}

/** Seerr issue lifecycle, consumed by the /report module (DMs the reporter). */
export interface IssueEvent {
  type: "issue";
  source: string;
  action: "resolved" | "reopened";
  issueId: number;
  title?: string;
  dedupeKey: string;
}

export type InboundEvent = MediaEvent | AlertEvent | IssueEvent;

/** Stable dedupe keys so Radarr, Seerr and Tautulli reports of one movie collapse into one line. */
export const keys = {
  movie: (tmdbId: number | undefined, title: string, year?: number) => (tmdbId ? `movie:tmdb:${tmdbId}` : `movie:t:${slug(title)}:${year ?? ""}`),
  series: (ids: { tmdbId?: number; tvdbId?: number }, title: string) =>
    ids.tvdbId ? `series:tvdb:${ids.tvdbId}` : ids.tmdbId ? `series:tmdb:${ids.tmdbId}` : `series:t:${slug(title)}`,
  episode: (show: string, season?: number, episode?: number) => `ep:${slug(show)}:s${season ?? "x"}e${episode ?? "x"}`,
  season: (show: string, season?: number | string) => `season:${slug(show)}:${season ?? "x"}`,
  album: (artist: string | undefined, title: string) => `album:${slug(normalizeTitle(artist))}:${slug(normalizeTitle(title))}`,
};

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function toInt(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function str(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === "number") return String(v);
  return undefined;
}
