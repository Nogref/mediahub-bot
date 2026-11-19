/** /random movie → a random movie from Plex, with a reroll button. */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type InteractionEditReplyOptions,
} from "discord.js";
import { Colors, truncate } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { PlexType } from "../services/plex.js";

export const random: ModuleFactory = ({ services, cfg }) => {
  const plex = services.plex;
  if (!plex) return null;

  async function pickMovie(): Promise<InteractionEditReplyOptions> {
    let sections = (await plex!.sections()).filter((s) => s.type === "movie");
    if (cfg.plex!.movieLibraries.length) {
      const wanted = new Set(cfg.plex!.movieLibraries.map((n) => n.toLowerCase()));
      sections = sections.filter((s) => wanted.has(s.title.toLowerCase()));
    }
    if (!sections.length) return { content: "I couldn't find a movie library in Plex." };

    // Weight by library size so every movie has the same odds.
    const counts = await Promise.all(sections.map((s) => plex!.count(s.key, PlexType.movie)));
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) return { content: "Your movie libraries are empty." };
    let n = Math.floor(Math.random() * total);
    let idx = 0;
    while (n >= counts[idx]) n -= counts[idx++];

    const movie = await plex!.itemAt(sections[idx].key, PlexType.movie, n);
    if (!movie) return { content: "Plex didn't return a movie. Try again." };

    const embed = new EmbedBuilder()
      .setColor(Colors.plex)
      .setTitle(truncate(`🎲 ${movie.title}${movie.year ? ` (${movie.year})` : ""}`, 256))
      .setDescription(truncate(movie.summary, 1000) || "*No summary.*")
      .setFooter({ text: `From ${sections[idx].title}` });
    const facts: string[] = [];
    if (movie.duration) facts.push(`${Math.round(movie.duration / 60_000)} min`);
    if (movie.contentRating) facts.push(movie.contentRating);
    if (movie.audienceRating ?? movie.rating) facts.push(`★ ${(movie.audienceRating ?? movie.rating)!.toFixed(1)}`);
    const genres = movie.Genre?.map((g) => g.tag).slice(0, 4).join(", ");
    if (facts.length) embed.addFields({ name: "Details", value: facts.join(" · "), inline: true });
    if (genres) embed.addFields({ name: "Genres", value: genres, inline: true });

    // Plex isn't public, so download the poster and attach it.
    const files: AttachmentBuilder[] = [];
    if (movie.thumb) {
      try {
        files.push(new AttachmentBuilder(await plex!.poster(movie.thumb), { name: "poster.jpg" }));
        embed.setThumbnail("attachment://poster.jpg");
      } catch (err) {
        log.debug(`random: poster download failed: ${(err as Error).message}`);
      }
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("random:movie").setLabel("Reroll").setEmoji("🎲").setStyle(ButtonStyle.Secondary),
    );
    const url = await plex!.webUrl(movie.ratingKey);
    if (url) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel("Open in Plex"));
    return { content: "", embeds: [embed], files, attachments: [], components: [row] };
  }

  return {
    name: "random",
    subcommands: [
      {
        parent: "random",
        parentDescription: "Can't decide what to watch?",
        name: "movie",
        description: "Pick a random movie from the Plex library",
        execute: async (i) => {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          await i.editReply(await pickMovie());
        },
      },
    ],
    components: {
      random: async (i) => {
        await i.deferUpdate();
        await i.editReply(await pickMovie());
      },
    },
  };
};
