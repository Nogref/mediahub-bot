/**
 * Where a request is right now. Uses Radarr/Sonarr directly when their API
 * keys are set (exact per-season counts and download progress), otherwise
 * Seerr's coarser view; Lidarr/Aurral for albums.
 */
import type { TrackedRequest } from "../core/db.js";
import type { ArrApi } from "../redownload/arr.js";
import type { Services } from "../services/index.js";
import { albumComplete } from "../services/lidarr.js";
import { MediaStatus } from "../services/seerr.js";
import type { RqState, RqTracker, SeasonProgress } from "./store.js";

type Json = Record<string, any>;

export interface Snapshot {
  state: Exclude<RqState, "stalled" | "expired">;
  progress?: number;
  eta?: string;
  queueStatus?: string;
  releaseAt?: number;
  seasons?: SeasonProgress[];
  tracks?: { have: number; total: number };
  /** How many things are on Plex (for noticing progress). */
  onPlex: number;
  requestedSeasons?: number[];
}

export interface ProgressDeps {
  services: Pick<Services, "seerr" | "lidarr" | "aurral">;
  radarr?: ArrApi;
  sonarr?: ArrApi;
}

const pct = (size: number, left: number) => (size > 0 ? Math.max(0, Math.min(100, Math.round(((size - left) / size) * 100))) : undefined);
const aired = (e: Json) => !!e.airDateUtc && Date.parse(e.airDateUtc) <= Date.now();

/** Pending approval / declined in Seerr. */
async function approval(d: ProgressDeps, r: TrackedRequest): Promise<{ state?: "approval" | "declined"; seasons?: number[] }> {
  if (!r.seerrRequestId || !d.services.seerr) return {};
  const req = await d.services.seerr.getRequest(r.seerrRequestId).catch(() => undefined);
  if (!req) return {};
  const seasons = req.seasons?.map((s) => s.seasonNumber).filter((n) => n > 0);
  if (req.status === 1) return { state: "approval", seasons };
  if (req.status === 3) return { state: "declined", seasons };
  return { seasons };
}

function queueProgress(items: Json[]) {
  const size = items.reduce((a, q) => a + Number(q.size ?? 0), 0);
  const left = items.reduce((a, q) => a + Number(q.sizeleft ?? 0), 0);
  const etas = items.map((q) => (q.estimatedCompletionTime ? Date.parse(q.estimatedCompletionTime) : NaN)).filter((n) => Number.isFinite(n));
  const status = items.some((q) => String(q.trackedDownloadStatus ?? "").toLowerCase() === "warning") ? "warning" : items[0]?.status;
  return { progress: pct(size, left), eta: etas.length ? new Date(Math.max(...etas)).toISOString() : undefined, queueStatus: status };
}

async function movie(d: ProgressDeps, r: TrackedRequest): Promise<Snapshot> {
  if (d.radarr && r.tmdbId) {
    const m = (await d.radarr.call<Json[]>(`/movie`, { query: { tmdbId: r.tmdbId } }))[0];
    if (!m) return { state: "searching", onPlex: 0 };
    if (m.hasFile) return { state: "done", onPlex: 1 };
    const queue = await d.radarr.call<Json[]>(`/queue/details`, { query: { movieId: m.id } });
    if (queue.length) return { state: "downloading", onPlex: 0, ...queueProgress(queue) };
    if (m.isAvailable === false) {
      const when = [m.digitalRelease, m.physicalRelease].map((x) => (x ? Date.parse(x) : NaN)).filter((n) => n > Date.now()).sort((a, b) => a - b)[0];
      return { state: "not_out", onPlex: 0, releaseAt: when };
    }
    return { state: "searching", onPlex: 0 };
  }
  return seerrCoarse(d, r);
}

async function series(d: ProgressDeps, r: TrackedRequest, requested?: number[]): Promise<Snapshot> {
  if (d.sonarr && r.tvdbId) {
    const s = (await d.sonarr.call<Json[]>(`/series`, { query: { tvdbId: r.tvdbId } }))[0];
    if (!s) return { state: "searching", onPlex: 0, requestedSeasons: requested };
    const [eps, queue] = await Promise.all([
      d.sonarr.call<Json[]>(`/episode`, { query: { seriesId: s.id } }),
      d.sonarr.call<Json[]>(`/queue/details`, { query: { seriesId: s.id } }),
    ]);
    if (!eps.length) return { state: "searching", onPlex: 0, requestedSeasons: requested };
    const wanted = requested?.length ? requested : [...new Set(eps.filter((e) => e.seasonNumber > 0).map((e) => e.seasonNumber as number))];
    const seasons: SeasonProgress[] = wanted
      .sort((a, b) => a - b)
      .map((n) => {
        const inSeason = eps.filter((e) => e.seasonNumber === n);
        const ids = new Set(inSeason.map((e) => e.id));
        const dl = queue.filter((q) => ids.has(q.episodeId));
        const upcoming = inSeason.filter((e) => !aired(e));
        const starts = upcoming.map((e) => (e.airDateUtc ? Date.parse(e.airDateUtc) : NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0];
        return {
          season: n,
          aired: inSeason.filter(aired).length,
          onPlex: inSeason.filter((e) => e.hasFile).length,
          downloading: new Set(dl.filter((q) => !inSeason.find((e) => e.id === q.episodeId)?.hasFile).map((q) => q.episodeId)).size,
          upcoming: upcoming.length,
          startsAt: inSeason.some(aired) ? undefined : starts,
          progress: dl.length ? queueProgress(dl).progress : undefined,
        };
      });
    const onPlex = seasons.reduce((a, x) => a + x.onPlex, 0);
    const out = seasons.filter((x) => x.aired > 0);
    if (!out.length) return { state: "not_out", onPlex, seasons, requestedSeasons: requested, releaseAt: seasons.map((x) => x.startsAt).filter((x): x is number => !!x).sort((a, b) => a - b)[0] };
    if (out.every((x) => x.onPlex >= x.aired)) return { state: "done", onPlex, seasons, requestedSeasons: requested };
    const downloading = seasons.some((x) => x.downloading > 0);
    return { state: downloading ? "downloading" : "searching", onPlex, seasons, requestedSeasons: requested, ...(downloading ? queueProgress(queue) : {}) };
  }
  return seerrCoarse(d, r, requested);
}

/** Without Radarr/Sonarr keys: Seerr's own status and download info. */
async function seerrCoarse(d: ProgressDeps, r: TrackedRequest, requested?: number[]): Promise<Snapshot> {
  const seerr = d.services.seerr;
  if (!seerr || !r.tmdbId) return { state: "searching", onPlex: 0 };
  const det = await seerr.details(r.kind === "movie" ? "movie" : "tv", r.tmdbId);
  const mi = det.mediaInfo as (typeof det.mediaInfo & { seasons?: Array<{ seasonNumber: number; status: number }> }) | undefined;
  const dl = mi?.downloadStatus ?? [];
  const seasons: SeasonProgress[] | undefined =
    r.kind === "tv"
      ? (mi?.seasons ?? [])
          .filter((x) => x.seasonNumber > 0 && (!requested?.length || requested.includes(x.seasonNumber)))
          .map((x) => ({
            season: x.seasonNumber,
            aired: 0,
            onPlex: 0,
            downloading: dl.filter((q) => q.episode?.seasonNumber === x.seasonNumber).length,
            upcoming: 0,
            coarse: x.status === MediaStatus.AVAILABLE ? "available" : x.status === MediaStatus.PARTIALLY_AVAILABLE ? "partial" : "processing",
          }))
      : undefined;
  if (mi?.status === MediaStatus.AVAILABLE) return { state: "done", onPlex: 1, seasons };
  if (dl.length) {
    const size = dl.reduce((a, x) => a + x.size, 0);
    const left = dl.reduce((a, x) => a + x.sizeLeft, 0);
    return { state: "downloading", onPlex: 0, seasons, progress: pct(size, left), eta: dl[0].estimatedCompletionTime };
  }
  return { state: "searching", onPlex: mi?.status === MediaStatus.PARTIALLY_AVAILABLE ? 1 : 0, seasons };
}

async function album(d: ProgressDeps, r: TrackedRequest): Promise<Snapshot> {
  const { lidarr, aurral } = d.services;
  if (r.target === "aurral") {
    if (!aurral || !r.aurralAlbumId) return { state: "searching", onPlex: 0 };
    const st = await aurral.albumStatus(r.aurralAlbumId);
    if (st.status === "complete") return { state: "done", onPlex: 1 };
    return { state: st.status === "downloading" ? "downloading" : "searching", onPlex: 0 };
  }
  if (!lidarr) return { state: "searching", onPlex: 0 };
  const a = r.lidarrAlbumId ? await lidarr.album(r.lidarrAlbumId) : r.mbAlbumId ? await lidarr.albumByForeignId(r.mbAlbumId) : undefined;
  if (!a) return { state: "searching", onPlex: 0 };
  const tracks = a.statistics ? { have: a.statistics.trackFileCount, total: a.statistics.totalTrackCount } : undefined;
  if (albumComplete(a)) return { state: "done", onPlex: tracks?.have ?? 1, tracks };
  const queue = await lidarr.queueFor([a.id]);
  if (queue.length) return { state: "downloading", onPlex: tracks?.have ?? 0, tracks, ...queueProgress(queue as Json[]) };
  if (a.releaseDate && Date.parse(a.releaseDate) > Date.now()) return { state: "not_out", onPlex: 0, releaseAt: Date.parse(a.releaseDate), tracks };
  return { state: "searching", onPlex: tracks?.have ?? 0, tracks };
}

export async function snapshot(d: ProgressDeps, r: TrackedRequest, t: RqTracker): Promise<Snapshot> {
  if (r.kind === "album") return album(d, r);
  const ap = await approval(d, r);
  const requested = t.requestedSeasons ?? ap.seasons;
  if (ap.state) return { state: ap.state, onPlex: 0, requestedSeasons: requested };
  return r.kind === "movie" ? movie(d, r) : series(d, r, requested);
}
