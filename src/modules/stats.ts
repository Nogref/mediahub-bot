/**
 * Library numbers: /stats on demand, plus an always-visible stats board
 * (/setup stats channel:#x) that refreshes every STATS_REFRESH_MINUTES and
 * is only edited when a number actually changes.
 */
import { ChannelType, EmbedBuilder, MessageFlags } from "discord.js";
import { Colors, ts } from "../core/discord.js";
import { friendlyError } from "../core/http.js";
import { LiveMessage } from "../core/liveMessage.js";
import { log } from "../core/logger.js";
import type { AppContext, ModuleFactory } from "../core/module.js";
import { PlexType } from "../services/plex.js";
import { SETUP } from "./settings.js";

const fmt = (n: number) => n.toLocaleString("en-US");
type Field = { name: string; value: string };

/** Runs one block; a failing service shows a short note instead of breaking the whole card. */
async function block(name: string, fn: () => Promise<string>): Promise<Field> {
  try {
    return { name, value: (await fn()) || "—" };
  } catch (err) {
    return { name, value: friendlyError(err).slice(0, 200) };
  }
}

export async function collectStats({ services, store }: Pick<AppContext, "services" | "store">): Promise<Field[]> {
  const { plex, lidarr, seerr } = services;
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
      block("🎵 Music (Lidarr)", async () => {
        const artists = await lidarr.artists();
        return `${fmt(artists.filter((a) => a.monitored).length)} monitored artists (${fmt(artists.length)} total)`;
      }),
    seerr &&
      block("📨 Seerr requests", async () => {
        const c = await seerr.requestCount();
        return `${fmt(c.total)} total · ${fmt(c.movie)} movies · ${fmt(c.tv)} series`;
      }),
    block("💬 Requested from Discord (last 7 days)", async () => {
      const c = store.requestCountSince(Date.now() - 7 * 86_400_000);
      return c.total ? `${fmt(c.total)} · ${fmt(c.movie)} movies · ${fmt(c.tv)} series · ${fmt(c.album)} albums` : "Nothing yet this week";
    }),
  ]);
  return blocks.filter((b): b is Field => Boolean(b));
}

export const stats: ModuleFactory = (ctx) => {
  const { cfg, store, client } = ctx;
  const board = new LiveMessage(client, store, "stats");
  let timer: NodeJS.Timeout | undefined;

  const boardEmbed = (fields: Field[], changedAt: number) =>
    new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle("📊 Library at a glance")
      .setDescription(`Last change ${ts(changedAt)}`)
      .addFields(fields)
      .setFooter({ text: `Checked every ${cfg.stats.refreshMinutes} min · /stats for a fresh copy` });

  /** Re-collects and edits the board only if a number changed. */
  async function refreshBoard(force = false): Promise<void> {
    if (!board.location) return;
    const fields = await collectStats(ctx);
    const sig = JSON.stringify(fields);
    const prev = store.kvGet<{ sig: string; at: number }>("stats.sig");
    if (!force && prev?.sig === sig) return;
    const at = prev?.sig === sig ? prev.at : Date.now();
    await board.update({ embeds: [boardEmbed(fields, at)] });
    store.kvSet("stats.sig", { sig, at });
  }

  return {
    name: "stats",
    commands: [
      {
        name: "stats",
        description: "Library and request numbers",
        execute: async (i) => {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const embed = new EmbedBuilder().setColor(Colors.info).setTitle("📊 Server stats").addFields(await collectStats(ctx)).setTimestamp(new Date());
          await i.editReply({ embeds: [embed] });
        },
      },
    ],
    subcommands: [
      {
        ...SETUP,
        name: "stats",
        description: "Post an always-up-to-date stats board in a channel, or move it",
        build: (b) => b.addChannelOption((o) => o.setName("channel").setDescription("Where it lives").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
        execute: async (i) => {
          const channel = i.options.getChannel("channel", true);
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const fields = await collectStats(ctx);
          const msg = await board.place(channel.id, { embeds: [boardEmbed(fields, Date.now())] });
          store.kvSet("stats.sig", { sig: JSON.stringify(fields), at: Date.now() });
          await i.editReply(`📊 Stats board posted in <#${msg.channelId}>. It refreshes every ${cfg.stats.refreshMinutes} minutes and only edits when a number changes.`);
        },
      },
    ],
    start: () => {
      // Other modules (or tests) can ask for an immediate re-check.
      ctx.bus.on("stats-refresh", () => void refreshBoard().catch((err) => log.warn(`stats: board refresh failed: ${(err as Error).message}`)));
      timer = setInterval(() => void refreshBoard().catch((err) => log.warn(`stats: board refresh failed: ${(err as Error).message}`)), cfg.stats.refreshMinutes * 60_000);
      // Catch up shortly after a restart.
      setTimeout(() => void refreshBoard().catch(() => undefined), 20_000).unref();
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
};
