/**
 * /setup channels, /setup links and /setup show: configure the bot from
 * Discord. Stored in the bot's database (on the appdata share), so it
 * survives restarts and never depends on the Unraid template.
 */
import { ChannelType, EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { Colors } from "../core/discord.js";
import { LiveMessage } from "../core/liveMessage.js";
import type { ModuleFactory, SubcommandDef } from "../core/module.js";
import { announcementsOn } from "../notify/announce.js";
import { OPT_CATEGORIES } from "../core/roles.js";
import { setChannel, setLink, type ChannelKey, type LinkKey } from "../core/settings.js";

import { commandsOnlyChannels } from "./commandsOnly.js";
import { SETUP } from "./parents.js";
export { SETUP };

const CHANNELS: Array<{ key: ChannelKey; option: string; label: string; help: string }> = [
  { key: "notify", option: "announcements", label: "Announcements", help: "New movies/shows/albums and 'your request is ready' pings" },
  { key: "status", option: "status", label: "Status board", help: "Live service status board + down/up heads-ups" },
  { key: "admin", option: "admin", label: "Admin notices", help: "Health issues, failed downloads, reports, invite log" },
  { key: "music", option: "music_announcements", label: "Music announcements", help: "Optional separate channel for new albums" },
  { key: "redownloadLog", option: "redownload_log", label: "Redownload log", help: "Every redownload, with Cancel/Approve/Ban buttons (admins only)" },
  { key: "suggestions", option: "suggestions", label: "Suggestions", help: "Where /suggest posts ideas for people to 👍 (make it read-only for members)" },
];

const LINKS: Array<{ key: LinkKey; option: string; label: string; help: string }> = [
  { key: "aurral", option: "aurral", label: "Aurral (public address)", help: "Where members open Aurral, e.g. https://music.example.com" },
  { key: "plezyRelay", option: "plezy_relay", label: "Plezy Watch Together relay", help: "Your relay, e.g. https://relay.example.com" },
];

const LIVE_KEYS = [
  { key: "welcome", label: "Welcome post" },
  { key: "plezy", label: "Plezy guide" },
  { key: "stats", label: "Stats board" },
  { key: "nowplaying", label: "Now playing board" },
  { key: "pings-panel", label: "Ping panel" },
  { key: "help", label: "Commands guide" },
];

export const settings: ModuleFactory = ({ cfg, store, client, roles, bus }) => {
  async function channels(i: ChatInputCommandInteraction) {
    const changes: string[] = [];
    for (const c of CHANNELS) {
      const ch = i.options.getChannel(c.option);
      if (ch) {
        setChannel(cfg, store, c.key, ch.id);
        changes.push(`${c.label} → <#${ch.id}>`);
      }
    }
    const clear = i.options.getString("clear");
    // (emitted below, after "clear" is applied)
    if (clear) {
      const c = CHANNELS.find((x) => x.key === clear)!;
      setChannel(cfg, store, c.key, null);
      changes.push(`${c.label} → *cleared*`);
    }
    if (changes.length) bus.emit("settings-changed");
    await i.reply({
      content: changes.length
        ? `✅ Saved:\n${changes.map((c) => `• ${c}`).join("\n")}\nThese take effect immediately.${changes.some((c) => c.startsWith("Status")) ? " The status board moves on its next check (within a minute)." : ""}`
        : "Nothing changed. Pick at least one channel (or `clear`).",
      flags: MessageFlags.Ephemeral,
    });
  }

  async function links(i: ChatInputCommandInteraction) {
    const changes: string[] = [];
    for (const l of LINKS) {
      const raw = i.options.getString(l.option)?.trim();
      if (raw === undefined) continue;
      if (raw === "" || raw.toLowerCase() === "none") {
        setLink(cfg, store, l.key, null);
        changes.push(`${l.label} → *cleared*`);
        continue;
      }
      try {
        const u = new URL(raw);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        await i.reply({ content: `⚠️ "${raw}" isn't a valid http(s) address.`, flags: MessageFlags.Ephemeral });
        return;
      }
      setLink(cfg, store, l.key, raw.replace(/\/+$/, ""));
      changes.push(`${l.label} → ${raw}`);
    }
    if (changes.length) bus.emit("settings-changed");
    await i.reply({
      content: changes.length ? `✅ Saved:\n${changes.map((c) => `• ${c}`).join("\n")}\nThe welcome post and Plezy guide update themselves.` : "Nothing changed.",
      flags: MessageFlags.Ephemeral,
    });
  }

  async function show(i: ChatInputCommandInteraction) {
    const live = LIVE_KEYS.map((l) => {
      const link = new LiveMessage(client, store, l.key).link(cfg.guildId);
      return `${l.label}: ${link ?? "*not posted*"}`;
    });
    const e = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle("⚙️ Bot setup")
      .addFields(
        { name: "Channels", value: CHANNELS.map((c) => `${c.label}: ${cfg.channels[c.key] ? `<#${cfg.channels[c.key]}>` : "*not set*"}`).join("\n") },
        { name: "Links", value: LINKS.map((l) => `${l.label}: ${cfg.links[l.key] ?? "*not set*"}`).join("\n") },
        { name: "Posts and boards", value: live.join("\n") },
        { name: "Ping roles", value: OPT_CATEGORIES.map((c) => `${c.emoji} ${c.name}: ${roles.get(c.key) ? `<@&${roles.get(c.key)}>` : "*not created yet*"}`).join("\n") },
        { name: "Announcements", value: announcementsOn(store) ? "📣 On: new movies, shows and albums are posted publicly" : "🔕 Off: requests are DMed only (`/setup announcements`)" },
        { name: "Commands-only channels", value: Object.keys(commandsOnlyChannels(store)).map((id) => `<#${id}>`).join(", ") || "*none* (`/setup commands-only`)" },
      )
      .setFooter({ text: "Change with /setup channels, /setup links, /setup welcome, /setup plezy, /setup stats, /setup nowplaying, /setup help, /setup commands-only, /setup announcements" });
    await i.reply({ embeds: [e], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  const subs: SubcommandDef[] = [
    {
      ...SETUP,
      name: "channels",
      description: "Choose where announcements, the status board and admin notices go",
      build: (b) => {
        for (const c of CHANNELS) {
          b.addChannelOption((o) => o.setName(c.option).setDescription(c.help).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement));
        }
        b.addStringOption((o) =>
          o
            .setName("clear")
            .setDescription("Unset one of them")
            .addChoices(...CHANNELS.map((c) => ({ name: c.label, value: c.key }))),
        );
        return b;
      },
      execute: channels,
    },
    {
      ...SETUP,
      name: "links",
      description: "Public addresses shown to members (Aurral, Plezy relay). Type 'none' to clear",
      build: (b) => {
        for (const l of LINKS) b.addStringOption((o) => o.setName(l.option).setDescription(l.help).setMaxLength(200));
        return b;
      },
      execute: links,
    },
    { ...SETUP, name: "show", description: "Show the current channels, links, posts and ping roles", execute: show },
  ];

  return { name: "settings", subcommands: subs };
};
