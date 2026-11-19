/** Aurral JSON API client. Docs: https://docs.aurral.org/api/overview/ */
import { request, type RequestOptions } from "../core/http.js";
import type { Config } from "../config.js";

export interface AurralAlbumSearchItem {
  id: string; // MusicBrainz release-group id
  title: string;
  artistName: string;
  artistMbid: string | null;
  releaseDate: string | null;
  primaryType: string | null;
  coverUrl: string | null;
  inLibrary?: boolean;
  status?: string;
}

export interface AurralRequestResult {
  success?: boolean;
  status?: string;
  album?: { id?: string | number; albumName?: string; status?: string };
  artist?: { id?: string | number; artistName?: string; mbid?: string };
  createdArtist?: boolean;
  triggeredSearch?: boolean;
  queued?: boolean;
  albumStatus?: { status?: string; recovery?: { code?: string; message?: string } } | null;
}

export class AurralClient {
  readonly name = "Aurral";

  constructor(private readonly cfg: NonNullable<Config["aurral"]>) {}

  private call<T>(path: string, opts: RequestOptions = {}) {
    return request<T>(this.name, `${this.cfg.url}/api${path}`, {
      ...opts,
      headers: { "X-Api-Key": this.cfg.apiKey, ...opts.headers },
    });
  }

  async health(): Promise<void> {
    await request(this.name, `${this.cfg.url}/api/health/live`, { timeoutMs: 5000, as: "text" });
  }

  async searchAlbums(q: string, limit = 5): Promise<AurralAlbumSearchItem[]> {
    const res = await this.call<{ items?: AurralAlbumSearchItem[] }>(`/search`, { query: { q, scope: "album", limit }, timeoutMs: 20_000 });
    return res.items ?? [];
  }

  /** POST /api/library/albums/request — adds the artist if needed and queues the album. */
  requestAlbum(body: { albumMbid: string; albumName: string; artistMbid: string; artistName: string }): Promise<AurralRequestResult> {
    return this.call(`/library/albums/request`, { method: "POST", body, timeoutMs: 30_000 });
  }

  /** Status is one of complete, downloading, queued, blocked, cancelled, failed, partial, missing. */
  albumStatus(albumId: string): Promise<{ status?: string; counts?: Record<string, number> }> {
    return this.call(`/library/albums/${encodeURIComponent(albumId)}/status`);
  }
}
