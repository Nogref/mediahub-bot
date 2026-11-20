/**
 * Radarr / Sonarr / Lidarr adapters for redownloads. Each speaks its own API
 * (Radarr/Sonarr v3, Lidarr v1) and exposes the same small surface (Adapter).
 */
import { request, type RequestOptions } from "../core/http.js";
import type { Adapter, AppKey, CurrentFile, ImportPreviewItem, QueueItem, Release, Target } from "./types.js";

type Json = Record<string, any>;

/** Release names compared loosely: case, punctuation, folders and extensions don't matter. */
export function normRelease(s: string | undefined | null): string {
  if (!s) return "";
  const base = s.split(/[\\/]/).pop() ?? s;
  return base
    .replace(/\.(mkv|mp4|avi|m4v|ts|flac|mp3|m4a|nzb|torrent)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export class ArrApi {
  constructor(
    readonly name: "Radarr" | "Sonarr" | "Lidarr",
    private readonly base: string, // e.g. http://radarr:7878/api/v3
    private readonly apiKey: string,
  ) {}

  call<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return request<T>(this.name, `${this.base}${path}`, { ...opts, headers: { "X-Api-Key": this.apiKey, ...opts.headers } });
  }
}

const qualityName = (q: Json | undefined) => q?.quality?.name ?? q?.name ?? "Unknown";

function toRelease(r: Json): Release {
  return {
    guid: r.guid,
    indexerId: r.indexerId,
    title: r.title,
    quality: qualityName(r.quality),
    qualityWeight: r.qualityWeight ?? 0,
    customFormatScore: r.customFormatScore ?? 0,
    size: r.size ?? 0,
    protocol: String(r.protocol ?? "unknown").toLowerCase(),
    seeders: r.seeders ?? undefined,
    ageMinutes: r.ageMinutes ?? undefined,
    indexer: r.indexer ?? undefined,
    rejections: (r.rejections ?? []).map((x: any) => (typeof x === "string" ? x : (x?.reason ?? x?.message ?? String(x)))),
    fullSeason: r.fullSeason ?? undefined,
  };
}

function toQueueItem(q: Json): QueueItem {
  return {
    id: q.id,
    downloadId: q.downloadId ?? undefined,
    title: q.title ?? "",
    state: q.trackedDownloadState ?? undefined,
    status: q.status ?? undefined,
    trackedStatus: q.trackedDownloadStatus ?? undefined,
    messages: (q.statusMessages ?? []).flatMap((m: Json) => m.messages ?? []).filter(Boolean),
    size: Number(q.size ?? 0),
    sizeLeft: Number(q.sizeleft ?? q.sizeLeft ?? 0),
    eta: q.estimatedCompletionTime ?? undefined,
  };
}

const rejectionText = (x: any): string => (typeof x === "string" ? x : (x?.reason ?? x?.message ?? String(x)));

/** Shared pieces: grabbing, queue, history, recycle bin, commands. */
abstract class BaseAdapter implements Adapter {
  abstract readonly app: AppKey;
  constructor(readonly api: ArrApi) {}
  get name() {
    return this.api.name;
  }

  protected abstract historyFor(t: Target): Promise<Json[]>;
  abstract currentFiles(t: Target): Promise<CurrentFile[]>;
  abstract search(t: Target): Promise<Release[]>;
  abstract queue(t: Target): Promise<QueueItem[]>;
  abstract importPreview(t: Target, downloadId: string): Promise<ImportPreviewItem[]>;
  abstract deleteFiles(t: Target, ids: number[]): Promise<void>;

  async recycleBin(): Promise<string | undefined> {
    const c = await this.api.call<Json>(`/config/mediamanagement`);
    const bin = typeof c.recycleBin === "string" ? c.recycleBin.trim() : "";
    return bin || undefined;
  }

  async grab(r: Release): Promise<void> {
    await this.api.call(`/release`, { method: "POST", body: { guid: r.guid, indexerId: r.indexerId }, timeoutMs: 60_000 });
  }

  async grabbedDownloadId(t: Target, releaseTitle: string, since: number): Promise<string | undefined> {
    const want = normRelease(releaseTitle);
    const hit = (await this.historyFor(t))
      .filter((h) => h.eventType === "grabbed" && Date.parse(h.date) >= since && normRelease(h.sourceTitle) === want)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
    return hit?.downloadId ?? undefined;
  }

  async downloadFailed(t: Target, downloadId: string): Promise<boolean> {
    return (await this.historyFor(t)).some((h) => h.eventType === "downloadFailed" && h.downloadId === downloadId);
  }

  /** Does a history record belong to this target? (Sonarr history is per series/season; narrow to the episodes.) */
  protected inTarget(t: Target, h: Json): boolean {
    if (t.app === "sonarr" && h.episodeId && t.ids.episodeIds?.length) return t.ids.episodeIds.includes(h.episodeId);
    return true;
  }

  /**
   * The grabs behind the files on disk now: matched by release name, or the
   * newest import when the files don't carry one. Used to never pick the same
   * release again, and to blocklist it once the replacement is in. A season
   * pack behind a single broken episode isn't blocklisted (that would mark the
   * whole pack failed); it's still skipped.
   */
  async currentGrabs(t: Target, files: CurrentFile[]): Promise<Array<{ historyId: number; title: string; downloadId?: string; blocklist: boolean }>> {
    const hist = await this.historyFor(t);
    const scoped = hist.filter((h) => this.inTarget(t, h));
    const imported = scoped.filter((h) => /imported$/i.test(h.eventType ?? "") && h.downloadId);
    const importedIds = new Set(imported.map((h) => h.downloadId as string));
    const byDownload = new Map<string, Json>();
    for (const h of scoped) if (h.eventType === "grabbed" && h.downloadId && importedIds.has(h.downloadId) && !byDownload.has(h.downloadId)) byDownload.set(h.downloadId, h);
    const grabs = [...byDownload.values()];

    const names = new Set(files.map((f) => normRelease(f.releaseTitle)).filter(Boolean));
    let mine = grabs.filter((g) => names.has(normRelease(g.sourceTitle)));
    if (!mine.length) {
      const newest = [...imported].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
      mine = newest ? grabs.filter((g) => g.downloadId === newest.downloadId) : [];
    }
    return mine.map((g) => {
      const episodesInGrab = hist.filter((h) => h.eventType === "grabbed" && h.downloadId === g.downloadId).length;
      const bigger = t.kind === "episode" && episodesInGrab > 1;
      return { historyId: g.id as number, title: g.sourceTitle as string, downloadId: g.downloadId as string, blocklist: !bigger };
    });
  }

  async markFailed(historyId: number): Promise<void> {
    await this.api.call(`/history/failed/${historyId}`, { method: "POST" });
  }

  async refreshDownloads(): Promise<void> {
    await this.api.call(`/command`, { method: "POST", body: { name: "RefreshMonitoredDownloads" } });
  }

  async removeFromQueue(id: number, blocklist: boolean): Promise<void> {
    await this.api.call(`/queue/${id}`, { method: "DELETE", query: { removeFromClient: true, blocklist } });
  }
}

export class RadarrAdapter extends BaseAdapter {
  readonly app = "radarr" as const;

  protected historyFor(t: Target) {
    return this.api.call<Json[]>(`/history/movie`, { query: { movieId: t.ids.movieId } });
  }

  async currentFiles(t: Target): Promise<CurrentFile[]> {
    const m = await this.api.call<Json>(`/movie/${t.ids.movieId}`);
    const f = m.movieFile;
    if (!m.hasFile || !f) return [];
    return [{ id: f.id, quality: qualityName(f.quality), size: f.size ?? 0, releaseTitle: f.sceneName ?? f.originalFilePath ?? f.relativePath }];
  }

  async search(t: Target): Promise<Release[]> {
    return (await this.api.call<Json[]>(`/release`, { query: { movieId: t.ids.movieId }, timeoutMs: 120_000 })).map(toRelease);
  }

  async queue(t: Target): Promise<QueueItem[]> {
    return (await this.api.call<Json[]>(`/queue/details`, { query: { movieId: t.ids.movieId } })).map(toQueueItem);
  }

  async importPreview(t: Target, downloadId: string): Promise<ImportPreviewItem[]> {
    const items = await this.api.call<Json[]>(`/manualimport`, { query: { downloadId, movieId: t.ids.movieId, filterExistingFiles: false } });
    return items.map((i) => ({ coveredIds: i.movie?.id ? [i.movie.id] : t.ids.movieId ? [t.ids.movieId] : [], rejections: (i.rejections ?? []).map(rejectionText) }));
  }

  async deleteFiles(_t: Target, ids: number[]): Promise<void> {
    for (const id of ids) await this.api.call(`/moviefile/${id}`, { method: "DELETE" });
  }
}

export class SonarrAdapter extends BaseAdapter {
  readonly app = "sonarr" as const;

  protected historyFor(t: Target) {
    return this.api.call<Json[]>(`/history/series`, { query: { seriesId: t.ids.seriesId, seasonNumber: t.ids.seasonNumber } });
  }

  async currentFiles(t: Target): Promise<CurrentFile[]> {
    const [episodes, files] = await Promise.all([
      this.api.call<Json[]>(`/episode`, { query: { seriesId: t.ids.seriesId, seasonNumber: t.ids.seasonNumber } }),
      this.api.call<Json[]>(`/episodefile`, { query: { seriesId: t.ids.seriesId } }),
    ]);
    const wanted = new Set(t.ids.episodeIds ?? []);
    const byFile = new Map<number, number[]>();
    for (const e of episodes) {
      if (!e.hasFile || !e.episodeFileId || !wanted.has(e.id)) continue;
      byFile.set(e.episodeFileId, [...(byFile.get(e.episodeFileId) ?? []), e.id]);
    }
    return files
      .filter((f) => byFile.has(f.id))
      .map((f) => ({ id: f.id, quality: qualityName(f.quality), size: f.size ?? 0, releaseTitle: f.sceneName ?? f.relativePath, coveredIds: byFile.get(f.id) }));
  }

  async search(t: Target): Promise<Release[]> {
    const query =
      t.kind === "episode" ? { episodeId: t.ids.episodeIds?.[0] } : { seriesId: t.ids.seriesId, seasonNumber: t.ids.seasonNumber };
    return (await this.api.call<Json[]>(`/release`, { query, timeoutMs: 120_000 })).map(toRelease);
  }

  async queue(t: Target): Promise<QueueItem[]> {
    const ids = (t.ids.episodeIds ?? []).map((id) => `episodeIds=${id}`).join("&");
    return (await this.api.call<Json[]>(`/queue/details?seriesId=${t.ids.seriesId}${ids ? `&${ids}` : ""}`)).map(toQueueItem);
  }

  async importPreview(t: Target, downloadId: string): Promise<ImportPreviewItem[]> {
    const items = await this.api.call<Json[]>(`/manualimport`, {
      query: { downloadId, seriesId: t.ids.seriesId, seasonNumber: t.ids.seasonNumber, filterExistingFiles: false },
    });
    return items.map((i) => ({ coveredIds: (i.episodes ?? []).map((e: Json) => e.id), rejections: (i.rejections ?? []).map(rejectionText) }));
  }

  async deleteFiles(_t: Target, ids: number[]): Promise<void> {
    if (ids.length) await this.api.call(`/episodefile/bulk`, { method: "DELETE", body: { episodeFileIds: ids } });
  }
}

export class LidarrAdapter extends BaseAdapter {
  readonly app = "lidarr" as const;

  protected historyFor(t: Target) {
    return this.api.call<Json[]>(`/history/artist`, { query: { artistId: t.ids.artistId, albumId: t.ids.albumId } });
  }

  async currentFiles(t: Target): Promise<CurrentFile[]> {
    const [files, tracks] = await Promise.all([
      this.api.call<Json[]>(`/trackfile`, { query: { albumId: t.ids.albumId } }),
      this.api.call<Json[]>(`/track`, { query: { albumId: t.ids.albumId } }),
    ]);
    const byFile = new Map<number, number[]>();
    for (const tr of tracks) if (tr.trackFileId) byFile.set(tr.trackFileId, [...(byFile.get(tr.trackFileId) ?? []), tr.id]);
    return files.map((f) => ({ id: f.id, quality: qualityName(f.quality), size: f.size ?? 0, releaseTitle: f.sceneName ?? f.path, coveredIds: byFile.get(f.id) ?? [] }));
  }

  async search(t: Target): Promise<Release[]> {
    return (await this.api.call<Json[]>(`/release`, { query: { albumId: t.ids.albumId }, timeoutMs: 120_000 })).map(toRelease);
  }

  async queue(t: Target): Promise<QueueItem[]> {
    return (await this.api.call<Json[]>(`/queue/details`, { query: { albumIds: t.ids.albumId } })).map(toQueueItem);
  }

  async importPreview(t: Target, downloadId: string): Promise<ImportPreviewItem[]> {
    const items = await this.api.call<Json[]>(`/manualimport`, { query: { downloadId, artistId: t.ids.artistId, filterExistingFiles: false } });
    return items.map((i) => ({ coveredIds: (i.tracks ?? []).map((tr: Json) => tr.id), rejections: (i.rejections ?? []).map(rejectionText) }));
  }

  async deleteFiles(_t: Target, ids: number[]): Promise<void> {
    if (ids.length) await this.api.call(`/trackfile/bulk`, { method: "DELETE", body: { trackFileIds: ids } });
  }
}

export type Adapters = Partial<Record<AppKey, BaseAdapter>>;

export function buildAdapters(cfg: {
  radarr?: { url: string; apiKey?: string };
  sonarr?: { url: string; apiKey?: string };
  lidarr?: { url: string; apiKey: string };
}): Adapters {
  return {
    radarr: cfg.radarr?.apiKey ? new RadarrAdapter(new ArrApi("Radarr", `${cfg.radarr.url}/api/v3`, cfg.radarr.apiKey)) : undefined,
    sonarr: cfg.sonarr?.apiKey ? new SonarrAdapter(new ArrApi("Sonarr", `${cfg.sonarr.url}/api/v3`, cfg.sonarr.apiKey)) : undefined,
    lidarr: cfg.lidarr ? new LidarrAdapter(new ArrApi("Lidarr", `${cfg.lidarr.url}/api/v1`, cfg.lidarr.apiKey)) : undefined,
  };
}

export type { BaseAdapter };
