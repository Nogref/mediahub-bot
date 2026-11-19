/** Plex Media Server API client (JSON via Accept header, token via X-Plex-Token header). */
import { request, type RequestOptions } from "../core/http.js";
import type { Config } from "../config.js";

export interface PlexSection {
  key: string;
  title: string;
  type: "movie" | "show" | "artist" | "photo" | string;
}

export interface PlexItem {
  ratingKey: string;
  title: string;
  year?: number;
  summary?: string;
  thumb?: string;
  duration?: number;
  contentRating?: string;
  audienceRating?: number;
  rating?: number;
  Genre?: Array<{ tag: string }>;
}

interface Container<T> {
  MediaContainer: T & { size?: number; totalSize?: number };
}

/** Plex metadata type numbers used by /library/sections/{key}/all?type= */
export const PlexType = { movie: 1, show: 2, season: 3, episode: 4, artist: 8, album: 9, track: 10 } as const;

export class PlexClient {
  readonly name = "Plex";
  private machineId?: string;

  constructor(private readonly cfg: NonNullable<Config["plex"]>) {}

  private call<T>(path: string, opts: RequestOptions = {}) {
    return request<T>(this.name, `${this.cfg.url}${path}`, {
      ...opts,
      headers: { "X-Plex-Token": this.cfg.token, "X-Plex-Client-Identifier": "mediahub-bot", "X-Plex-Product": "MediaHub Bot", ...opts.headers },
    });
  }

  async health(): Promise<void> {
    await this.call(`/identity`, { timeoutMs: 5000 });
  }

  async machineIdentifier(): Promise<string | undefined> {
    if (!this.machineId) {
      const res = await this.call<Container<{ machineIdentifier?: string }>>(`/identity`);
      this.machineId = res.MediaContainer.machineIdentifier;
    }
    return this.machineId;
  }

  async sections(): Promise<PlexSection[]> {
    const res = await this.call<Container<{ Directory?: PlexSection[] }>>(`/library/sections`);
    return res.MediaContainer.Directory ?? [];
  }

  /** Item count of a section without downloading the items. */
  async count(sectionKey: string, type?: number): Promise<number> {
    const res = await this.call<Container<object>>(`/library/sections/${sectionKey}/all`, {
      query: { type, "X-Plex-Container-Start": 0, "X-Plex-Container-Size": 0 },
    });
    return res.MediaContainer.totalSize ?? res.MediaContainer.size ?? 0;
  }

  async itemAt(sectionKey: string, type: number, offset: number): Promise<PlexItem | undefined> {
    const res = await this.call<Container<{ Metadata?: PlexItem[] }>>(`/library/sections/${sectionKey}/all`, {
      query: { type, "X-Plex-Container-Start": offset, "X-Plex-Container-Size": 1 },
    });
    return res.MediaContainer.Metadata?.[0];
  }

  /** Downloads a resized poster so it can be attached to a message (Plex itself stays private). */
  async poster(thumb: string, width = 400, height = 600): Promise<Buffer> {
    return this.call<Buffer>(`/photo/:/transcode`, {
      query: { width, height, minSize: 1, upscale: 1, url: thumb },
      headers: { Accept: "image/jpeg" },
      as: "buffer",
    });
  }

  /** Deep link into app.plex.tv for an item. */
  async webUrl(ratingKey: string): Promise<string | undefined> {
    const id = await this.machineIdentifier().catch(() => undefined);
    if (!id) return undefined;
    return `https://app.plex.tv/desktop/#!/server/${id}/details?key=${encodeURIComponent(`/library/metadata/${ratingKey}`)}`;
  }
}
