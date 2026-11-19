/**
 * Subsonic API client (Aurral's built-in server at /rest, or Navidrome).
 * Token auth (md5(password + salt)) by default; falls back to password auth
 * when the server can't do tokens (Subsonic error 41).
 */
import { createHash, randomBytes } from "node:crypto";
import { ApiError, request } from "../core/http.js";
import type { Config } from "../config.js";

export interface SubsonicSong {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  albumId?: string;
  duration?: number; // seconds
  coverArt?: string;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist?: string;
  year?: number;
  songCount?: number;
  coverArt?: string;
}

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount?: number;
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  songCount?: number;
}

type Envelope<T> = { "subsonic-response": { status: "ok" | "failed"; error?: { code: number; message?: string } } & T };

const CLIENT = "mediahub-bot";
const VERSION = "1.16.1";

export class SubsonicClient {
  readonly name = "Subsonic";
  private usePassword = false;

  constructor(private readonly cfg: NonNullable<Config["subsonic"]>) {}

  get bitrate(): number {
    return this.cfg.bitrate;
  }

  /** Query-string auth for every call. Note: the result contains credentials, never show it to users. */
  private auth(): Record<string, string> {
    const base = { u: this.cfg.user, v: VERSION, c: CLIENT, f: "json" };
    if (this.usePassword) return { ...base, p: `enc:${Buffer.from(this.cfg.password).toString("hex")}` };
    const s = randomBytes(8).toString("hex");
    const t = createHash("md5").update(this.cfg.password + s).digest("hex");
    return { ...base, t, s };
  }

  /** URL for a binary endpoint (stream, getCoverArt). Contains credentials: keep it server-side. */
  url(method: string, params: Record<string, string | number> = {}): string {
    const u = new URL(`${this.cfg.url}/rest/${method}`);
    for (const [k, v] of Object.entries({ ...this.auth(), ...params })) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async call<T>(method: string, params: Record<string, string | number> = {}, retried = false): Promise<T> {
    const res = await request<Envelope<T>>(this.name, this.url(method, params));
    const body = res["subsonic-response"];
    if (!body) throw new ApiError(this.name, "parse", "Subsonic server returned an unexpected response");
    if (body.status !== "ok") {
      const code = body.error?.code;
      if (code === 41 && !retried && !this.usePassword) {
        this.usePassword = true; // server can't verify tokens (no stored password); use password auth
        return this.call<T>(method, params, true);
      }
      const msg = code === 40 ? "wrong Subsonic username or password" : (body.error?.message ?? `error ${code}`);
      throw new ApiError(this.name, "http", `Subsonic: ${msg}`, code === 40 ? 401 : 400);
    }
    return body as unknown as T;
  }

  async health(): Promise<void> {
    await this.call("ping", {});
  }

  async search(query: string, counts = { song: 10, album: 6, artist: 4 }) {
    const r = await this.call<{ searchResult3?: { song?: SubsonicSong[]; album?: SubsonicAlbum[]; artist?: SubsonicArtist[] } }>("search3", {
      query,
      songCount: counts.song,
      albumCount: counts.album,
      artistCount: counts.artist,
    });
    return { songs: r.searchResult3?.song ?? [], albums: r.searchResult3?.album ?? [], artists: r.searchResult3?.artist ?? [] };
  }

  async album(id: string): Promise<SubsonicAlbum & { song: SubsonicSong[] }> {
    const r = await this.call<{ album: SubsonicAlbum & { song?: SubsonicSong[] } }>("getAlbum", { id });
    return { ...r.album, song: r.album.song ?? [] };
  }

  async song(id: string): Promise<SubsonicSong> {
    return (await this.call<{ song: SubsonicSong }>("getSong", { id })).song;
  }

  async topSongs(artistName: string, count = 25): Promise<SubsonicSong[]> {
    return (await this.call<{ topSongs?: { song?: SubsonicSong[] } }>("getTopSongs", { artist: artistName, count })).topSongs?.song ?? [];
  }

  async randomSongs(size = 25): Promise<SubsonicSong[]> {
    return (await this.call<{ randomSongs?: { song?: SubsonicSong[] } }>("getRandomSongs", { size })).randomSongs?.song ?? [];
  }

  async playlists(): Promise<SubsonicPlaylist[]> {
    return (await this.call<{ playlists?: { playlist?: SubsonicPlaylist[] } }>("getPlaylists")).playlists?.playlist ?? [];
  }

  async playlist(id: string): Promise<SubsonicPlaylist & { entry: SubsonicSong[] }> {
    const r = await this.call<{ playlist: SubsonicPlaylist & { entry?: SubsonicSong[] } }>("getPlaylist", { id });
    return { ...r.playlist, entry: r.playlist.entry ?? [] };
  }

  /** Opus-in-Ogg stream, so audio goes straight to Discord without transcoding in the bot. */
  streamUrl(id: string): string {
    return this.url("stream", { id, format: "opus", maxBitRate: this.cfg.bitrate });
  }

  async coverArt(id: string, size = 300): Promise<Buffer> {
    return request<Buffer>(this.name, this.url("getCoverArt", { id, size }), { as: "buffer", headers: { Accept: "image/*" } });
  }
}
