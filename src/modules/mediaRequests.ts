/**
 * /request movie <query> and /request series <query> → Seerr.
 *
 * No approval queue, no quotas: Seerr auto-approves everything the bot sends
 * (the API key acts as Seerr's admin), and Radarr/Sonarr take it from there.
 * The member gets a live tracker by DM (src/requests).
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
import { Colors, truncate, yearOf } from "../core/discord.js";
import type { ModuleFactory } from "../core/module.js";
import { MediaStatus, posterUrl, type SeerrMediaInfo, type SeerrMediaType, type SeerrSearchResult } from "../services/seerr.js";

const MAX_RESULTS = 5;
const PARENT = { parent: "request", parentDescription: "Ask for a movie, TV show or album" } as const;

interface StatusInfo {
  label: string;
  color: number;
  requestable: boolean;
  alreadyRequested: boolean;
}

export function seerrStatus(mi: SeerrMediaInfo | undefined): StatusInfo {
  switch (mi?.status) {
    case MediaStatus.AVAILABLE:
      return { label: "✅ Already in the library", color: Colors.ok, requestable: false, alreadyRequested: false };
    case MediaStatus.PARTIALLY_AVAILABLE:
      return { label: "🟡 Partly in the library — request the rest", color: Colors.warn, requestable: true, alreadyRequested: false };
    case MediaStatus.PENDING:
    case MediaStatus.PROCESSING:
      return { label: "⏳ Already requested — on its way", color: Colors.info, requestable: true, alreadyRequested: true };
    case MediaStatus.BLOCKLISTED:
      return { label: "🚫 Can't be requested", color: Colors.muted, requestable: false, alreadyRequested: false };
    default:
      return { label: "➕ Not requested yet", color: Colors.muted, requestable: true, alreadyRequested: false };
  }
}

const titleOf = (r: { title?: string; name?: string }) => r.title ?? r.name ?? "Untitled";
const yearFor = (r: { releaseDate?: string; firstAirDate?: string }) => yearOf(r.releaseDate ?? r.firstAirDate);

export const mediaRequests: ModuleFactory = ({ services, store, bus }) => {
  const seerr = services.seerr;
  if (!seerr) return null;

  async function search(i: ChatInputCommandInteraction, type: SeerrMediaType) {
    const query = i.options.getString("query", true).trim();
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const results = (await seerr!.search(query)).filter((r): r is SeerrSearchResult & { mediaType: SeerrMediaType } => r.mediaType === type).slice(0, MAX_RESULTS);
    const noun = type === "movie" ? "movies" : "series";
    if (!results.length) {
      await i.editReply(`🔍 No ${noun} found for **${truncate(query, 80)}**. Try a different spelling or add the year.`);
      return;
    }

    const embeds = results.map((r, idx) => {
      const st = seerrStatus(r.mediaInfo);
      const year = yearFor(r);
      const e = new EmbedBuilder()
        .setColor(st.color)
        .setTitle(truncate(`${idx + 1}. ${titleOf(r)}${year ? ` (${year})` : ""}`, 256))
        .setDescription(`${st.label}\n${truncate(r.overview, 220) || "*No overview.*"}`);
      const poster = posterUrl(r.posterPath, "w185");
      if (poster) e.setThumbnail(poster);
      const link = seerr!.webUrl(type, r.id);
      if (link) e.setURL(link);
      return e;
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      results.map((r, idx) => {
        const st = seerrStatus(r.mediaInfo);
        return new ButtonBuilder()
          .setCustomId(`seerr:${type}:${r.id}`)
          .setLabel(truncate(`${idx + 1}. ${titleOf(r)}`, 80))
          .setStyle(st.alreadyRequested ? ButtonStyle.Secondary : st.requestable ? ButtonStyle.Primary : ButtonStyle.Success)
          .setDisabled(!st.requestable);
      }),
    );

    await i.editReply({
      content: `Results for **${truncate(query, 80)}**. Pick one to request it:`,
      embeds,
      components: [row],
    });
  }

  async function pick(i: MessageComponentInteraction) {
    const [, type, idRaw] = i.customId.split(":") as [string, SeerrMediaType, string];
    const tmdbId = Number(idRaw);
    await i.deferUpdate();
    await i.editReply({ content: "⏳ Sending your request…", embeds: [], components: [] });

    const details = await seerr!.details(type, tmdbId);
    const title = titleOf(details);
    const year = yearFor(details);
    const label = `${title}${year ? ` (${year})` : ""}`;
    const poster = posterUrl(details.posterPath);
    const tvdbId = details.externalIds?.tvdbId;
    const status = details.mediaInfo?.status;

    const card = (color: number, heading: string, body: string) => {
      const e = new EmbedBuilder().setColor(color).setTitle(truncate(`${heading}: ${label}`, 256)).setDescription(body);
      if (poster) e.setThumbnail(poster);
      const link = seerr!.webUrl(type, tmdbId);
      if (link) e.setURL(link);
      return e;
    };

    const follow = (seerrRequestId?: number) =>
      store.addRequest({
        discordUserId: i.user.id,
        kind: type === "movie" ? "movie" : "tv",
        target: "seerr",
        title,
        year,
        tmdbId,
        tvdbId,
        seerrRequestId,
        posterUrl: poster,
      });

    /** Hands over to the live tracker (DM + this reply). */
    const tracked = async (id: number, note?: string, fallback?: EmbedBuilder, madeSeerrRequest?: number) => {
      await i.editReply({ content: "✅ Requested! Setting up your tracker…", embeds: [], components: [] });
      if (!bus.emit("request-created", { id, reply: i, note, madeSeerrRequest })) {
        await i.editReply({ content: "", embeds: [fallback ?? card(Colors.ok, "📨 Requested", "It's on its way. `/requests` shows how it's going.")] });
      }
    };

    if (status === MediaStatus.AVAILABLE) {
      await i.editReply({ content: "", embeds: [card(Colors.ok, "✅ Already in the library", "It's on Plex right now. Enjoy!")] });
      return;
    }

    const userId = await seerr!.userIdForDiscord(i.user.id);
    const outcome = await seerr!.createRequest({ mediaType: type, mediaId: tmdbId, tvdbId, userId });

    switch (outcome.kind) {
      case "created":
        await tracked(follow(outcome.request.id), undefined, undefined, outcome.request.id);
        return;
      case "duplicate":
        await tracked(follow(details.mediaInfo?.requests?.[0]?.id), "Someone else asked for it first, so it's already on its way.");
        return;
      case "nothing-left":
        if (status !== undefined && status !== MediaStatus.UNKNOWN) {
          await tracked(
            follow(details.mediaInfo?.requests?.[0]?.id),
            "Everything that's out is already here or on its way.",
            card(Colors.info, "✅ Nothing left to request", "Everything that's out is already here or on its way."),
          );
          return;
        }
        await i.editReply({ content: "", embeds: [card(Colors.info, "✅ Nothing left to request", "Everything that's out is already here or on its way.")] });
        return;
      case "refused":
        await i.editReply({ content: "", embeds: [card(Colors.bad, "🚫 Couldn't request this", truncate(outcome.message, 500) || "Please try again later, or ask an admin.")] });
        return;
    }
  }

  return {
    name: "media-requests",
    subcommands: [
      {
        ...PARENT,
        name: "movie",
        description: "Ask for a movie. I'll DM you as it downloads",
        build: (b) => b.addStringOption((o) => o.setName("query").setDescription("Movie title, optionally with year").setRequired(true).setMaxLength(100)),
        execute: (i) => search(i, "movie"),
      },
      {
        ...PARENT,
        name: "series",
        description: "Ask for a TV show. I'll DM you as it downloads",
        build: (b) => b.addStringOption((o) => o.setName("query").setDescription("Series title").setRequired(true).setMaxLength(100)),
        execute: (i) => search(i, "tv"),
      },
    ],
    components: { seerr: pick },
  };
};
