/**
 * /request album <query> → Lidarr (add artist if needed, monitor album, AlbumSearch)
 * with Aurral as the fallback, or the other way round (MUSIC_REQUEST_TARGET).
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from "discord.js";
import { Colors, shortId, truncate, yearOf } from "../core/discord.js";
import { ApiError } from "../core/http.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { TtlCache } from "../core/ttlCache.js";
import type { AurralClient } from "../services/aurral.js";
import { albumComplete, albumCover, type LidarrAlbum, type LidarrClient } from "../services/lidarr.js";

const MAX_RESULTS = 5;
type Source = "lidarr" | "aurral";
const NAMES: Record<Source, string> = { lidarr: "Lidarr", aurral: "Aurral" };

export interface MusicCandidate {
  source: Source;
  title: string;
  artistName: string;
  artistMbid?: string;
  albumMbid: string;
  year?: number;
  albumType?: string;
  coverUrl?: string;
  state: "available" | "monitored" | "new";
  /** Full Lidarr album resource, needed if we have to POST /api/v1/album. */
  lidarrAlbum?: LidarrAlbum;
}

interface Outcome {
  via: Source;
  state: "requested" | "available" | "saved-no-source";
  steps: string[];
  lidarrAlbumId?: number;
  aurralAlbumId?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function caaCover(mbid: string) {
  return `https://coverartarchive.org/release-group/${mbid}/front-250`;
}

export function fromLidarr(album: LidarrAlbum): MusicCandidate {
  const state = album.id > 0 ? (albumComplete(album) ? "available" : album.monitored ? "monitored" : "new") : "new";
  return {
    source: "lidarr",
    title: album.title,
    artistName: album.artist?.artistName ?? "Unknown artist",
    artistMbid: album.artist?.foreignArtistId,
    albumMbid: album.foreignAlbumId,
    year: yearOf(album.releaseDate),
    albumType: album.albumType,
    coverUrl: albumCover(album),
    state,
    lidarrAlbum: album,
  };
}

export const musicRequests: ModuleFactory = ({ services, store, cfg, bus }) => {
  const lidarr = services.lidarr;
  const aurral = services.aurral;
  if (!lidarr && !aurral) return null;

  const sessions = new TtlCache<string, { userId: string; candidates: MusicCandidate[] }>(15 * 60_000, 500);
  const order: Source[] = (cfg.music.primary === "aurral" ? (["aurral", "lidarr"] as const) : (["lidarr", "aurral"] as const)).filter((s) =>
    s === "lidarr" ? Boolean(lidarr) : Boolean(aurral),
  );

  async function searchSource(src: Source, q: string): Promise<MusicCandidate[]> {
    if (src === "lidarr") {
      const res = await lidarr!.search(q);
      return res.flatMap((r) => (r.album?.foreignAlbumId ? [fromLidarr(r.album)] : [])).slice(0, MAX_RESULTS);
    }
    const items = await aurral!.searchAlbums(q, MAX_RESULTS);
    return items
      .filter((a) => a.id && a.artistMbid)
      .map((a) => ({
        source: "aurral" as const,
        title: a.title,
        artistName: a.artistName,
        artistMbid: a.artistMbid ?? undefined,
        albumMbid: a.id,
        year: yearOf(a.releaseDate),
        albumType: a.primaryType ?? undefined,
        coverUrl: caaCover(a.id),
        state: a.inLibrary ? ("available" as const) : ("new" as const),
      }));
  }

  /** Primary first; on outage or zero hits, the other one. */
  async function search(q: string): Promise<{ candidates: MusicCandidate[] }> {
    let lastErr: unknown;
    for (const [idx, src] of order.entries()) {
      const next = order[idx + 1];
      try {
        const candidates = await searchSource(src, q);
        if (candidates.length || !next) return { candidates };
        log.info(`music: ${NAMES[src]} found nothing for "${q}"; trying ${NAMES[next]}`);
      } catch (err) {
        if (!(err instanceof ApiError) || !next) throw err;
        lastErr = err;
        log.warn(`music: ${NAMES[src]} search failed (${err.message}); trying ${NAMES[next]}`);
      }
    }
    if (lastErr) throw lastErr;
    return { candidates: [] };
  }

  async function command(i: ChatInputCommandInteraction) {
    const q = i.options.getString("query", true).trim();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const { candidates } = await search(q);
    if (!candidates.length) {
      await i.editReply(`🔍 No albums found for **${truncate(q, 80)}**. Try "artist album" or check the spelling.`);
      return;
    }
    const sid = shortId();
    sessions.set(sid, { userId: i.user.id, candidates });

    const label = (c: MusicCandidate) =>
      c.state === "available" ? "✅ Already in the library" : c.state === "monitored" ? "⏳ Already requested, on its way" : "➕ Not in the library yet";
    const embeds = candidates.map((c, idx) => {
      const e = new EmbedBuilder()
        .setColor(c.state === "available" ? Colors.ok : c.state === "monitored" ? Colors.info : Colors.muted)
        .setTitle(truncate(`${idx + 1}. ${c.title}${c.year ? ` (${c.year})` : ""}`, 256))
        .setDescription(`by **${truncate(c.artistName, 100)}**${c.albumType ? ` · ${c.albumType}` : ""}\n${label(c)}`);
      if (c.coverUrl) e.setThumbnail(c.coverUrl);
      e.setURL(`https://musicbrainz.org/release-group/${c.albumMbid}`);
      return e;
    });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      candidates.map((c, idx) =>
        new ButtonBuilder()
          .setCustomId(`music:${sid}:${idx}`)
          .setLabel(truncate(`${idx + 1}. ${c.title}`, 80))
          .setStyle(c.state === "available" ? ButtonStyle.Success : c.state === "monitored" ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(c.state === "available"),
      ),
    );
    await i.editReply({
      content: `Albums for **${truncate(q, 80)}**. Pick one to request it:`,
      embeds,
      components: [row],
    });
  }

  /** Waits for Lidarr's post-add artist refresh to create the album record. */
  async function waitForAlbum(client: LidarrClient, mbid: string, timeoutMs: number): Promise<LidarrAlbum | undefined> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const a = await client.albumByForeignId(mbid).catch(() => undefined);
      if (a) return a;
      await sleep(3000);
    }
    return undefined;
  }

  async function viaLidarr(c: MusicCandidate, progress: (s: string) => Promise<void>): Promise<Outcome> {
    const steps: string[] = [];
    let album = await lidarr!.albumByForeignId(c.albumMbid);

    if (!album) {
      let artist = c.artistMbid ? await lidarr!.artistByMbId(c.artistMbid) : undefined;
      if (!artist) {
        if (!c.artistMbid) throw new Error("This result is missing some details, so I can't request it. Try another result.");
        const d = await lidarr!.addDefaults();
        await progress(`⏳ Adding **${c.artistName}** to the music library… new artists can take up to a minute.`);
        artist = await lidarr!.addArtist({
          artistName: c.artistName,
          foreignArtistId: c.artistMbid,
          qualityProfileId: d.qualityProfileId,
          metadataProfileId: d.metadataProfileId,
          rootFolderPath: d.rootFolderPath,
          monitored: true,
          monitorNewItems: "none",
          addOptions: { monitor: "none", albumsToMonitor: [c.albumMbid], searchForMissingAlbums: false },
        });
        steps.push(`Added artist **${artist.artistName}** to Lidarr (only this album is monitored)`);
        album = await waitForAlbum(lidarr!, c.albumMbid, 45_000);
      }
      if (!album) {
        // Not in the artist's catalogue yet, e.g. the metadata profile filters this release type.
        if (!c.lidarrAlbum) throw new ApiError("Lidarr", "http", "Lidarr doesn't list this album for the artist", 404);
        const added = await lidarr!.addAlbum({
          ...c.lidarrAlbum,
          artistId: artist.id,
          artist,
          monitored: true,
          addOptions: { searchForNewAlbum: false },
        });
        steps.push("Added the album to Lidarr (monitored)");
        await lidarr!.command("AlbumSearch", { albumIds: [added.id] });
        steps.push("Search started");
        return { via: "lidarr", state: "requested", steps, lidarrAlbumId: added.id };
      }
    }

    if (albumComplete(album)) return { via: "lidarr", state: "available", steps, lidarrAlbumId: album.id };
    if (!album.monitored) {
      await lidarr!.setMonitored([album.id], true);
      steps.push("Album is now monitored");
    } else {
      steps.push("Album was already monitored");
    }
    await lidarr!.command("AlbumSearch", { albumIds: [album.id] });
    steps.push("Search started");
    return { via: "lidarr", state: "requested", steps, lidarrAlbumId: album.id };
  }

  async function viaAurral(c: MusicCandidate): Promise<Outcome> {
    if (!c.artistMbid) throw new Error("This result is missing some details, so I can't request it. Try another result.");
    const res = await (aurral as AurralClient).requestAlbum({
      albumMbid: c.albumMbid,
      albumName: c.title,
      artistMbid: c.artistMbid,
      artistName: c.artistName,
    });
    const steps: string[] = [];
    if (res.createdArtist) steps.push(`Added artist **${c.artistName}** in Aurral`);
    const albumId = res.album?.id !== undefined ? String(res.album.id) : undefined;
    const st = res.albumStatus?.status ?? res.status;
    if (res.status === "available" || st === "complete") return { via: "aurral", state: "available", steps, aurralAlbumId: albumId };
    if (res.albumStatus?.recovery?.code === "download_source_missing") {
      steps.push("Aurral saved the request but has no download source configured");
      return { via: "aurral", state: "saved-no-source", steps, aurralAlbumId: albumId };
    }
    steps.push(res.queued || res.triggeredSearch ? "Download queued in Aurral" : `Request saved in Aurral (status: ${st ?? "queued"})`);
    return { via: "aurral", state: "requested", steps, aurralAlbumId: albumId };
  }

  async function pick(i: MessageComponentInteraction) {
    const [, sid, idxRaw] = i.customId.split(":");
    const session = sessions.get(sid);
    const c = session?.candidates[Number(idxRaw)];
    if (!session || !c) {
      await i.update({ content: "⌛ This search expired. Run `/request album` again.", embeds: [], components: [] });
      return;
    }
    await i.deferUpdate();
    const progress = (s: string) => i.editReply({ content: s, embeds: [], components: [] }).then(() => undefined);
    await progress(`⏳ Requesting **${c.title}** by **${c.artistName}**…`);

    // Try the result's own source first, then the other one when it's down or can't find the album.
    const tryOrder: Source[] = [c.source, ...order.filter((s) => s !== c.source)];
    let outcome: Outcome | undefined;
    let lastErr: unknown;
    for (const [idx, src] of tryOrder.entries()) {
      try {
        outcome = src === "lidarr" ? await viaLidarr(c, progress) : await viaAurral(c);
        break;
      } catch (err) {
        lastErr = err;
        const next = tryOrder[idx + 1];
        const fallbackWorthy = err instanceof ApiError && (err.unreachable || err.status === 404);
        if (!next || !fallbackWorthy) throw err;
        log.warn(`music: ${NAMES[src]} request failed (${(err as Error).message}); falling back to ${NAMES[next]}`);
        await progress(`⏳ Requesting **${c.title}** by **${c.artistName}** another way…`);
      }
    }
    if (!outcome) throw lastErr;

    const embed = new EmbedBuilder().setThumbnail(c.coverUrl ?? null).setURL(`https://musicbrainz.org/release-group/${c.albumMbid}`);
    const heading = `${c.title} by ${c.artistName}`;

    if (outcome.state === "available") {
      embed.setColor(Colors.ok).setTitle(truncate(`✅ Already in the library: ${heading}`, 256)).setDescription("It's ready to stream.");
    } else {
      const id = store.addRequest({
        discordUserId: i.user.id,
        kind: "album",
        target: outcome.via,
        title: c.title,
        year: c.year,
        artistName: c.artistName,
        mbAlbumId: c.albumMbid,
        mbArtistId: c.artistMbid,
        lidarrAlbumId: outcome.lidarrAlbumId,
        aurralAlbumId: outcome.aurralAlbumId,
        posterUrl: c.coverUrl,
      });
      log.info(`music: ${i.user.id} requested ${heading} via ${NAMES[outcome.via]}: ${outcome.steps.join("; ")}`);
      const note = outcome.state === "saved-no-source" ? "⚠️ An admin needs to finish setting up music downloads before this can download." : undefined;
      await i.editReply({ content: "✅ Requested! Setting up your tracker…", embeds: [], components: [] });
      if (bus.emit("request-created", { id, reply: i, note })) return;
      embed
        .setColor(note ? Colors.warn : Colors.ok)
        .setTitle(truncate(`🎵 Requested: ${heading}`, 256))
        .setDescription(note ?? "It's on its way. `/requests` shows how it's going.");
    }
    await i.editReply({ content: "", embeds: [embed], components: [] });
  }

  return {
    name: "music-requests",
    subcommands: [
      {
        parent: "request",
        parentDescription: "Ask for a movie, TV show or album",
        name: "album",
        description: "Ask for an album. It's added to the music library automatically",
        build: (b) => b.addStringOption((o) => o.setName("query").setDescription("Album and/or artist name").setRequired(true).setMaxLength(100)),
        execute: command,
      },
    ],
    components: { music: pick },
  };
};
