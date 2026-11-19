/** Lidarr v1 API client. Docs: <LIDARR_URL>/docs or https://lidarr.audio/docs/api/ */
import { request, type RequestOptions } from "../core/http.js";
import type { Config } from "../config.js";

export interface LidarrImage {
  coverType: string;
  url?: string;
  remoteUrl?: string;
}

export interface LidarrArtist {
  id: number;
  artistName: string;
  foreignArtistId: string;
  monitored: boolean;
  qualityProfileId?: number;
  metadataProfileId?: number;
  rootFolderPath?: string;
  path?: string;
}

export interface LidarrAlbum {
  id: number;
  title: string;
  foreignAlbumId: string;
  artistId: number;
  monitored: boolean;
  albumType?: string;
  releaseDate?: string;
  overview?: string;
  images?: LidarrImage[];
  remoteCover?: string;
  artist?: LidarrArtist;
  statistics?: { trackFileCount: number; trackCount: number; totalTrackCount: number; percentOfTracks: number };
  [extra: string]: unknown;
}

export interface LidarrSearchResult {
  foreignId: string;
  artist?: LidarrArtist;
  album?: LidarrAlbum;
}

interface Named {
  id: number;
  name: string;
}

export function albumCover(album: LidarrAlbum): string | undefined {
  if (album.remoteCover) return album.remoteCover;
  const cover = album.images?.find((i) => i.coverType === "cover") ?? album.images?.[0];
  const remote = cover?.remoteUrl ?? cover?.url;
  if (remote && /^https?:\/\//.test(remote)) return remote;
  return album.foreignAlbumId ? `https://coverartarchive.org/release-group/${album.foreignAlbumId}/front-250` : undefined;
}

export function albumComplete(album: LidarrAlbum): boolean {
  const s = album.statistics;
  if (!s) return false;
  return s.percentOfTracks >= 100 || (s.totalTrackCount > 0 && s.trackFileCount >= s.totalTrackCount);
}

export class LidarrClient {
  readonly name = "Lidarr";
  private defaults?: { rootFolderPath: string; qualityProfileId: number; metadataProfileId: number };

  constructor(private readonly cfg: NonNullable<Config["lidarr"]>) {}

  private call<T>(path: string, opts: RequestOptions = {}) {
    return request<T>(this.name, `${this.cfg.url}/api/v1${path}`, {
      ...opts,
      headers: { "X-Api-Key": this.cfg.apiKey, ...opts.headers },
    });
  }

  async health(): Promise<void> {
    await this.call(`/system/status`, { timeoutMs: 5000 });
  }

  search(term: string): Promise<LidarrSearchResult[]> {
    return this.call(`/search`, { query: { term }, timeoutMs: 20_000 });
  }

  async artistByMbId(mbId: string): Promise<LidarrArtist | undefined> {
    const res = await this.call<LidarrArtist[]>(`/artist`, { query: { mbId } });
    return res[0];
  }

  artists(): Promise<LidarrArtist[]> {
    return this.call(`/artist`);
  }

  async albumByForeignId(foreignAlbumId: string): Promise<LidarrAlbum | undefined> {
    const res = await this.call<LidarrAlbum[]>(`/album`, { query: { foreignAlbumId } });
    return res[0];
  }

  album(id: number): Promise<LidarrAlbum> {
    return this.call(`/album/${id}`);
  }

  setMonitored(albumIds: number[], monitored: boolean): Promise<unknown> {
    return this.call(`/album/monitor`, { method: "PUT", body: { albumIds, monitored } });
  }

  addArtist(body: Record<string, unknown>): Promise<LidarrArtist> {
    return this.call(`/artist`, { method: "POST", body });
  }

  addAlbum(body: Record<string, unknown>): Promise<LidarrAlbum> {
    return this.call(`/album`, { method: "POST", body });
  }

  /** Active downloads for these albums. */
  queueFor(albumIds: number[]): Promise<Array<{ albumId?: number; size: number; sizeleft: number; status?: string; estimatedCompletionTime?: string; trackedDownloadState?: string }>> {
    if (!albumIds.length) return Promise.resolve([]);
    const qs = albumIds.map((id) => `albumIds=${id}`).join("&");
    return request(this.name, `${this.cfg.url}/api/v1/queue/details?${qs}&includeAlbum=false`, { headers: { "X-Api-Key": this.cfg.apiKey } });
  }

  command(name: string, body: Record<string, unknown> = {}): Promise<{ id: number; status: string }> {
    return this.call(`/command`, { method: "POST", body: { name, ...body } });
  }

  /**
   * Root folder, quality profile and metadata profile used when the bot adds an
   * artist. Env values may be a path/ID/name; otherwise Lidarr's first entry is used.
   */
  async addDefaults() {
    if (this.defaults) return this.defaults;
    const [roots, qps, mps] = await Promise.all([
      this.call<Array<{ id: number; path: string }>>(`/rootfolder`),
      this.call<Named[]>(`/qualityprofile`),
      this.call<Named[]>(`/metadataprofile`),
    ]);
    const pick = (list: Named[], wanted: string | undefined, label: string): number => {
      if (!list.length) throw new Error(`Lidarr has no ${label} configured`);
      if (!wanted) return list[0].id;
      const hit = list.find((p) => String(p.id) === wanted || p.name.toLowerCase() === wanted.toLowerCase());
      if (!hit) throw new Error(`Lidarr has no ${label} called "${wanted}" (have: ${list.map((p) => p.name).join(", ")})`);
      return hit.id;
    };
    const wantedRoot = this.cfg.rootFolder?.replace(/\/+$/, "");
    const root = wantedRoot ? roots.find((r) => r.path.replace(/\/+$/, "") === wantedRoot) : roots[0];
    if (!root) {
      throw new Error(
        wantedRoot ? `LIDARR_ROOT_FOLDER "${wantedRoot}" isn't a root folder in Lidarr (have: ${roots.map((r) => r.path).join(", ")})` : "Lidarr has no root folder configured",
      );
    }
    this.defaults = {
      rootFolderPath: root.path,
      qualityProfileId: pick(qps, this.cfg.qualityProfile, "quality profile"),
      metadataProfileId: pick(mps, this.cfg.metadataProfile, "metadata profile"),
    };
    return this.defaults;
  }
}
