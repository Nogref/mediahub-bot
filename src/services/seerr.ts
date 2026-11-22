/** Seerr (Overseerr/Jellyseerr successor) API client. Docs: <SEERR_URL>/api-docs */
import { ApiError, request, requestRaw, type RequestOptions } from "../core/http.js";
import { log } from "../core/logger.js";
import { TtlCache } from "../core/ttlCache.js";
import type { Config } from "../config.js";

/** Seerr MediaStatus enum (server/constants/media.ts). */
export const MediaStatus = {
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
  BLOCKLISTED: 6,
  DELETED: 7,
} as const;

export type SeerrMediaType = "movie" | "tv";

export interface SeerrDownload {
  size: number;
  sizeLeft: number;
  status: string;
  timeLeft?: string;
  estimatedCompletionTime?: string;
  title?: string;
  episode?: { seasonNumber: number; episodeNumber: number };
}

export interface SeerrMediaInfo {
  id?: number; // Seerr's own media id (needed for issues)
  tmdbId?: number;
  tvdbId?: number;
  status?: number;
  requests?: Array<{ id: number }>;
  downloadStatus?: SeerrDownload[];
}

/** Seerr IssueType enum. */
export const IssueType = { video: 1, audio: 2, subtitles: 3, other: 4 } as const;

export interface SeerrSearchResult {
  id: number; // TMDB id
  mediaType: SeerrMediaType | "person" | "collection";
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string;
  overview?: string;
  mediaInfo?: SeerrMediaInfo;
}

export interface SeerrMediaDetails {
  id: number;
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string;
  overview?: string;
  externalIds?: { tvdbId?: number };
  mediaInfo?: SeerrMediaInfo;
}

export interface SeerrRequest {
  id: number;
  status: number; // 1 pending approval, 2 approved, 3 declined, 4 failed, 5 completed
  type?: SeerrMediaType;
  createdAt?: string;
  seasons?: Array<{ seasonNumber: number }>;
  media?: SeerrMediaInfo & { mediaType?: SeerrMediaType };
  requestedBy?: { id: number; displayName?: string };
}

export type CreateRequestOutcome =
  | { kind: "created"; request: SeerrRequest }
  | { kind: "duplicate"; message: string }
  | { kind: "nothing-left"; message: string }
  | { kind: "refused"; message: string };

export function posterUrl(path: string | undefined, size = "w342"): string | undefined {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

/** Seerr's validator rejects some characters that encodeURIComponent leaves alone. */
function encodeQuery(q: string): string {
  return encodeURIComponent(q).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export class SeerrClient {
  readonly name = "Seerr";
  private discordMap = new TtlCache<string, Map<string, number>>(30 * 60_000);

  constructor(private readonly cfg: NonNullable<Config["seerr"]>) {}

  private call<T>(path: string, opts: RequestOptions = {}) {
    return request<T>(this.name, `${this.cfg.url}/api/v1${path}`, {
      ...opts,
      headers: { "X-Api-Key": this.cfg.apiKey, ...opts.headers },
    });
  }

  /** Public link to a title in Seerr's web UI, when SEERR_PUBLIC_URL is set. */
  webUrl(type: SeerrMediaType, tmdbId: number): string | undefined {
    return this.cfg.publicUrl ? `${this.cfg.publicUrl}/${type}/${tmdbId}` : undefined;
  }

  async health(): Promise<void> {
    await request(this.name, `${this.cfg.url}/api/v1/status`, { timeoutMs: 5000 });
  }

  async search(query: string): Promise<SeerrSearchResult[]> {
    // Query is pre-encoded by hand, so build the URL directly instead of via `query`.
    const res = await request<{ results: SeerrSearchResult[] }>(
      this.name,
      `${this.cfg.url}/api/v1/search?query=${encodeQuery(query)}&page=1`,
      { headers: { "X-Api-Key": this.cfg.apiKey } },
    );
    return res.results ?? [];
  }

  details(type: SeerrMediaType, tmdbId: number): Promise<SeerrMediaDetails> {
    return this.call<SeerrMediaDetails>(`/${type}/${tmdbId}`);
  }

  getRequest(id: number): Promise<SeerrRequest> {
    return this.call<SeerrRequest>(`/request/${id}`);
  }

  createIssue(body: {
    issueType: number;
    message: string;
    mediaId: number;
    problemSeason?: number;
    problemEpisode?: number;
    userId?: number;
  }): Promise<{ id: number }> {
    return this.call(`/issue`, { method: "POST", body });
  }

  /** status: 1 open, 2 resolved. */
  getIssue(id: number): Promise<{ id: number; status: number }> {
    return this.call(`/issue/${id}`);
  }

  requestCount(): Promise<{ total: number; movie: number; tv: number; pending: number; approved: number; available?: number }> {
    return this.call(`/request/count`);
  }

  /**
   * Creates a request. With the API key the caller is Seerr's admin, so Seerr
   * auto-approves it no matter which user it's attributed to.
   */
  async createRequest(body: { mediaType: SeerrMediaType; mediaId: number; tvdbId?: number; userId?: number }): Promise<CreateRequestOutcome> {
    const payload: Record<string, unknown> = { mediaType: body.mediaType, mediaId: body.mediaId };
    if (body.mediaType === "tv") {
      payload.seasons = "all";
      if (body.tvdbId) payload.tvdbId = body.tvdbId;
    }
    if (body.userId) payload.userId = body.userId;
    try {
      const res = await requestRaw<SeerrRequest & { message?: string }>(this.name, `${this.cfg.url}/api/v1/request`, {
        method: "POST",
        headers: { "X-Api-Key": this.cfg.apiKey },
        body: payload,
      });
      // NoSeasonsAvailableError comes back as HTTP 202 with a message instead of a request.
      if (res.status === 202 || !res.data?.id) {
        return { kind: "nothing-left", message: res.data?.message ?? "No seasons left to request." };
      }
      return { kind: "created", request: res.data };
    } catch (err) {
      if (err instanceof ApiError && err.kind === "http") {
        const msg = (err.body as { message?: string } | undefined)?.message ?? err.message;
        if (err.status === 409) return { kind: "duplicate", message: msg };
        if (err.status === 403) return { kind: "refused", message: msg };
        // Retry without attribution if the mapped user can't be used for some reason.
        if (body.userId && (err.status === 400 || err.status === 404)) {
          log.warn(`seerr: request as user ${body.userId} failed (${msg}); retrying as the API key owner`);
          return this.createRequest({ ...body, userId: undefined });
        }
      }
      throw err;
    }
  }

  /**
   * Finds the Seerr user that has this Discord ID saved in Profile → Notifications.
   * Cached for 30 minutes; returns undefined when no one has linked it.
   */
  async userIdForDiscord(discordId: string): Promise<number | undefined> {
    if (!this.cfg.attributeUsers) return undefined;
    return (await this.discordUsers())?.get(discordId);
  }

  /** The Discord account(s) a Seerr user saved in Profile → Notifications (for tracking requests made in Seerr). */
  async discordIdsForUser(seerrUserId: number): Promise<string[]> {
    const map = await this.discordUsers();
    return map ? [...map.entries()].filter(([, uid]) => uid === seerrUserId).map(([d]) => d) : [];
  }

  /** Newest requests first. */
  async recentRequests(take = 50): Promise<SeerrRequest[]> {
    const page = await this.call<{ results: SeerrRequest[] }>(`/request`, { query: { take, skip: 0, sort: "added", filter: "all" } });
    return page.results ?? [];
  }

  private async discordUsers(): Promise<Map<string, number> | undefined> {
    let map = this.discordMap.get("all");
    if (!map) {
      map = new Map();
      try {
        const users: Array<{ id: number }> = [];
        for (let skip = 0; skip < 1000; skip += 100) {
          const page = await this.call<{ results: Array<{ id: number }> }>(`/user`, { query: { take: 100, skip } });
          users.push(...(page.results ?? []));
          if ((page.results ?? []).length < 100) break;
        }
        // Small concurrency to stay friendly with Seerr.
        for (let i = 0; i < users.length; i += 5) {
          await Promise.all(
            users.slice(i, i + 5).map(async (u) => {
              try {
                const s = await this.call<{ discordIds?: string[]; discordId?: string }>(`/user/${u.id}/settings/notifications`);
                const ids = [...(s.discordIds ?? []), ...(s.discordId ? [s.discordId] : [])];
                for (const d of ids) if (d) map!.set(d, u.id);
              } catch {
                /* one unreadable user shouldn't block the rest */
              }
            }),
          );
        }
        this.discordMap.set("all", map);
      } catch (err) {
        log.warn(`seerr: could not build the Discord→Seerr user map: ${(err as Error).message}`);
        return undefined;
      }
    }
    return map;
  }
}
