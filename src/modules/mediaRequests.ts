/**
 * /request movie <query> and /request series <query> → Seerr.
 *
 * No approval queue, no quotas: Seerr auto-approves everything the bot sends
 * (the API key acts as Seerr's admin), and Radarr/Sonarr take it from there.
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
      return { label: "🚫 Blocklisted in Seerr", color: Colors.muted, requestable: false, alreadyRequested: false };
    default:
      return { label: "➕ Not requested yet", color: Colors.muted, requestable: true, alreadyRequested: false };
  }
}

const titleOf = (r: { title?: string; name?: string }) => r.title ?? r.name ?? "Untitled";
const yearFor = (r: { releaseDate?: string; firstAirDate?: string }) => yearOf(r.releaseDate ?? r.firstAirDate);

export const mediaRequests: ModuleFactory = ({ services, store, cfg }) => {
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
    await i.editReply({ content: "⏳ Sending your request to Seerr…", embeds: [], components: [] });

    const details = await seerr!.details(type, tmdbId);
    const title = titleOf(details);
    const year = yearFor(details);
    const label = `${title}${year ? ` (${year})` : ""}`;
    const poster = posterUrl(details.posterPath);
    const tvdbId = details.externalIds?.tvdbId;
    const status = details.mediaInfo?.status;
    const where = cfg.channels.notify ? ` in <#${cfg.channels.notify}>` : "";

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

    if (status === MediaStatus.AVAILABLE) {
      await i.editReply({ content: "", embeds: [card(Colors.ok, "✅ Already in the library", "It's on Plex right now. Enjoy!")] });
      return;
    }

    const userId = await seerr!.userIdForDiscord(i.user.id);
    const outcome = await seerr!.createRequest({ mediaType: type, mediaId: tmdbId, tvdbId, userId });

    switch (outcome.kind) {
      case "created": {
        follow(outcome.request.id);
        const pendingApproval = outcome.request.status === 1;
        const lines = [
          pendingApproval
            ? "Seerr saved it but marked it **pending approval**. Check that Seerr's auto-approve is on."
            : `Approved. ${type === "movie" ? "Radarr" : "Sonarr"} will pick it up automatically.`,
          `I'll @ you${where} when it's on Plex.`,
          userId ? "" : "\n*Tip: add your Discord user ID in Seerr → Profile → Settings → Notifications to have requests show under your name.*",
        ].filter(Boolean);
        await i.editReply({ content: "", embeds: [card(pendingApproval ? Colors.warn : Colors.ok, "📨 Requested", lines.join("\n"))] });
        return;
      }
      case "duplicate":
        follow(details.mediaInfo?.requests?.[0]?.id);
        await i.editReply({
          content: "",
          embeds: [card(Colors.info, "⏳ Already requested", `Someone already asked for this and it's on its way. I'll @ you${where} too when it lands.`)],
        });
        return;
      case "nothing-left":
        if (status !== undefined && status !== MediaStatus.UNKNOWN) follow(details.mediaInfo?.requests?.[0]?.id);
        await i.editReply({
          content: "",
          embeds: [card(Colors.info, "✅ Nothing left to request", "Every season is already in the library or already requested.")],
        });
        return;
      case "refused":
        await i.editReply({ content: "", embeds: [card(Colors.bad, "🚫 Seerr refused the request", truncate(outcome.message, 500))] });
        return;
    }
  }

  return {
    name: "media-requests",
    subcommands: [
      {
        ...PARENT,
        name: "movie",
        description: "Ask for a movie. It downloads automatically",
        build: (b) => b.addStringOption((o) => o.setName("query").setDescription("Movie title, optionally with year").setRequired(true).setMaxLength(100)),
        execute: (i) => search(i, "movie"),
      },
      {
        ...PARENT,
        name: "series",
        description: "Ask for a TV show. It downloads automatically",
        build: (b) => b.addStringOption((o) => o.setName("query").setDescription("Series title").setRequired(true).setMaxLength(100)),
        execute: (i) => search(i, "tv"),
      },
    ],
    components: { seerr: pick },
  };
};
