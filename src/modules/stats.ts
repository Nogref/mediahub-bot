/** /stats → library size (Plex), monitored artists (Lidarr), request count (Seerr). */
import { EmbedBuilder, MessageFlags } from "discord.js";
import { Colors } from "../core/discord.js";
import { friendlyError } from "../core/http.js";
import type { ModuleFactory } from "../core/module.js";
import { PlexType } from "../services/plex.js";

const fmt = (n: number) => n.toLocaleString("en-US");

export const stats: ModuleFactory = ({ services }) => {
  const { plex, lidarr, seerr } = services;
  if (!plex && !lidarr && !seerr) return null;

  /** Runs one block; a failing service shows a short note instead of breaking the reply. */
  async function block(name: string, fn: () => Promise<string>): Promise<{ name: string; value: string }> {
    try {
      return { name, value: (await fn()) || "—" };
    } catch (err) {
      return { name, value: friendlyError(err).slice(0, 200) };
    }
  }

  return {
    name: "stats",
    commands: [
      {
        name: "stats",
        description: "Library and request numbers",
        execute: async (i) => {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const blocks = await Promise.all([
            plex &&
              block("📚 Plex library", async () => {
                const sections = await plex.sections();
                const lines = await Promise.all(
                  sections.map(async (s) => {
                    if (s.type === "movie") return `**${s.title}**: ${fmt(await plex.count(s.key, PlexType.movie))} movies`;
                    if (s.type === "show") {
                      const [shows, eps] = await Promise.all([plex.count(s.key, PlexType.show), plex.count(s.key, PlexType.episode)]);
                      return `**${s.title}**: ${fmt(shows)} shows · ${fmt(eps)} episodes`;
                    }
                    if (s.type === "artist") {
                      const [artists, albums] = await Promise.all([plex.count(s.key, PlexType.artist), plex.count(s.key, PlexType.album)]);
                      return `**${s.title}**: ${fmt(artists)} artists · ${fmt(albums)} albums`;
                    }
                    return `**${s.title}**: ${fmt(await plex.count(s.key))} items`;
                  }),
                );
                return lines.join("\n");
              }),
            lidarr &&
              block("🎵 Lidarr", async () => {
                const artists = await lidarr.artists();
                const monitored = artists.filter((a) => a.monitored).length;
                return `${fmt(monitored)} monitored artists (${fmt(artists.length)} total)`;
              }),
            seerr &&
              block("📨 Seerr requests", async () => {
                const c = await seerr.requestCount();
                return `${fmt(c.total)} total · ${fmt(c.movie)} movies · ${fmt(c.tv)} series`;
              }),
          ]);
          const embed = new EmbedBuilder()
            .setColor(Colors.info)
            .setTitle("📊 Server stats")
            .addFields(blocks.filter((b): b is { name: string; value: string } => Boolean(b)))
            .setTimestamp(new Date());
          await i.editReply({ embeds: [embed] });
        },
      },
    ],
  };
};
