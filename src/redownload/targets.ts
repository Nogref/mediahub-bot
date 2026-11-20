/**
 * Finding what to redownload: library search for autocomplete, and turning a
 * pick ("m:12", "s:7" + season/episode, "a:40") into a Target.
 */
import { truncate } from "../core/discord.js";
import { TtlCache } from "../core/ttlCache.js";
import { keys } from "../notify/events.js";
import type { Adapters } from "./arr.js";
import type { Target } from "./types.js";

type Json = Record<string, any>;

export interface LibraryEntry {
  value: string;
  name: string;
  haystack: string;
}

const poster = (images: Json[] | undefined) => {
  const u = (images ?? []).find((i) => i.coverType === "poster" || i.coverType === "cover")?.remoteUrl;
  return typeof u === "string" && /^https?:\/\//.test(u) ? u : undefined;
};

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export class Library {
  private cache = new TtlCache<string, LibraryEntry[]>(5 * 60_000);

  constructor(private readonly adapters: Adapters) {}

  private async load(app: "radarr" | "sonarr" | "lidarr"): Promise<LibraryEntry[]> {
    const hit = this.cache.get(app);
    if (hit) return hit;
    const a = this.adapters[app];
    if (!a) return [];
    let out: LibraryEntry[] = [];
    if (app === "radarr") {
      const movies = await a.api.call<Json[]>(`/movie`);
      out = movies
        .filter((m) => m.hasFile)
        .map((m) => ({ value: `m:${m.id}`, name: `🎬 ${m.title}${m.year ? ` (${m.year})` : ""}`, haystack: fold(`${m.title} ${m.originalTitle ?? ""} ${m.year ?? ""}`) }));
    } else if (app === "sonarr") {
      const series = await a.api.call<Json[]>(`/series`);
      out = series
        .filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0)
        .map((s) => ({ value: `s:${s.id}`, name: `📺 ${s.title}${s.year ? ` (${s.year})` : ""}`, haystack: fold(`${s.title} ${s.year ?? ""}`) }));
    } else {
      const [albums, artists] = await Promise.all([a.api.call<Json[]>(`/album`), a.api.call<Json[]>(`/artist`)]);
      const names = new Map(artists.map((x) => [x.id, x.artistName as string]));
      out = albums
        .filter((al) => (al.statistics?.trackFileCount ?? 0) > 0)
        .map((al) => {
          const artist = al.artist?.artistName ?? names.get(al.artistId) ?? "";
          return { value: `a:${al.id}`, name: `🎵 ${artist ? `${artist} – ` : ""}${al.title}`, haystack: fold(`${artist} ${al.title}`) };
        });
    }
    this.cache.set(app, out);
    return out;
  }

  async search(typed: string, limit = 25): Promise<Array<{ name: string; value: string }>> {
    const q = fold(typed);
    if (q.length < 2) return [];
    const words = q.split(" ");
    const all = (await Promise.all((["radarr", "sonarr", "lidarr"] as const).map((app) => this.load(app).catch(() => [])))).flat();
    const scored = all
      .filter((e) => words.every((w) => e.haystack.includes(w)))
      .map((e) => ({ e, score: (e.haystack.startsWith(q) ? 0 : 1) + e.haystack.length / 1000 }))
      .sort((a, b) => a.score - b.score)
      .slice(0, limit);
    return scored.map(({ e }) => ({ name: truncate(e.name, 100), value: e.value }));
  }

  forget() {
    this.cache = new TtlCache(5 * 60_000);
  }
}

export class TargetError extends Error {}

export async function resolveTarget(adapters: Adapters, pick: string, season?: number, episode?: number): Promise<Target> {
  const m = pick.match(/^([msa]):(\d+)$/);
  if (!m) throw new TargetError("Pick a title from the suggestions as you type.");
  const id = Number(m[2]);

  if (m[1] === "m") {
    const a = adapters.radarr;
    if (!a) throw new TargetError("Movie redownloads aren't set up (Radarr needs an API key).");
    if (season !== undefined || episode !== undefined) throw new TargetError("Season and episode are only for series. Leave them empty for movies.");
    const mv = await a.api.call<Json>(`/movie/${id}`);
    if (!mv.hasFile) throw new TargetError(`**${mv.title}** isn't downloaded yet, so there's nothing to replace. Request it instead.`);
    const label = `${mv.title}${mv.year ? ` (${mv.year})` : ""}`;
    return {
      kind: "movie",
      app: "radarr",
      key: `radarr:${id}`,
      label,
      posterUrl: poster(mv.images),
      ids: { movieId: id },
      weight: 1,
      dedupeKeys: [keys.movie(mv.tmdbId, mv.title, mv.year)],
    };
  }

  if (m[1] === "s") {
    const a = adapters.sonarr;
    if (!a) throw new TargetError("TV redownloads aren't set up (Sonarr needs an API key).");
    if (season === undefined) throw new TargetError("Which season? Add the **season** option, plus **episode** for a single episode (leave episode empty to replace the whole season).");
    const [series, episodes] = await Promise.all([
      a.api.call<Json>(`/series/${id}`),
      a.api.call<Json[]>(`/episode`, { query: { seriesId: id, seasonNumber: season } }),
    ]);
    const withFiles = episodes.filter((e) => e.hasFile);
    const sLabel = season === 0 ? "Specials" : `Season ${season}`;
    if (episode !== undefined) {
      const ep = episodes.find((e) => e.episodeNumber === episode);
      if (!ep) throw new TargetError(`**${series.title}** has no S${pad(season)}E${pad(episode)}.`);
      if (!ep.hasFile) throw new TargetError(`**${series.title}** S${pad(season)}E${pad(episode)} isn't downloaded yet, so there's nothing to replace.`);
      return {
        kind: "episode",
        app: "sonarr",
        key: `sonarr:${id}:${season}:${ep.id}`,
        label: `${series.title} S${pad(season)}E${pad(episode)}${ep.title && ep.title !== "TBA" ? ` · ${ep.title}` : ""}`,
        posterUrl: poster(series.images),
        ids: { seriesId: id, seasonNumber: season, episodeIds: [ep.id] },
        weight: 1,
        dedupeKeys: [keys.episode(series.title, season, episode), keys.season(series.title, season)],
      };
    }
    if (!withFiles.length) throw new TargetError(`**${series.title}** ${sLabel} has nothing downloaded yet.`);
    return {
      kind: "season",
      app: "sonarr",
      key: `sonarr:${id}:${season}`,
      label: `${series.title} · ${sLabel}`,
      posterUrl: poster(series.images),
      ids: { seriesId: id, seasonNumber: season, episodeIds: withFiles.map((e) => e.id) },
      weight: 2,
      dedupeKeys: [keys.season(series.title, season), ...withFiles.map((e) => keys.episode(series.title, season, e.episodeNumber))],
    };
  }

  const a = adapters.lidarr;
  if (!a) throw new TargetError("Album redownloads aren't set up (Lidarr isn't configured).");
  if (season !== undefined || episode !== undefined) throw new TargetError("Season and episode are only for series. Leave them empty for albums.");
  const al = await a.api.call<Json>(`/album/${id}`);
  if (!(al.statistics?.trackFileCount > 0)) throw new TargetError(`**${al.title}** isn't downloaded yet, so there's nothing to replace.`);
  const artistName: string = al.artist?.artistName ?? (await a.api.call<Json>(`/artist/${al.artistId}`)).artistName;
  return {
    kind: "album",
    app: "lidarr",
    key: `lidarr:${id}`,
    label: `${artistName} – ${al.title}`,
    posterUrl: poster(al.images),
    ids: { albumId: id, artistId: al.artistId },
    weight: 1,
    dedupeKeys: [keys.album(artistName, al.title)],
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
