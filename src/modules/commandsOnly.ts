/**
 * Commands-only channels: members can use / commands there, but anything they
 * type as a normal message is removed straight away. Slash commands aren't
 * messages, so they're never affected.
 *
 *   /setup commands-only channel:#general mode:on|off
 *
 * Never removed: bots (including this one), webhooks, Discord's system
 * messages, pinned messages, admins and the server owner. Messages from before
 * a channel was switched on are never touched; after a restart, anything
 * posted while the bot was offline is cleaned up.
 *
 * The person gets a friendly DM saying why (at most every few hours), or, with
 * DMs closed, a short note in the channel that deletes itself.
 *
 * Needs the bot to have Manage Messages in those channels. Doesn't need the
 * Message Content intent: it never reads what was written.
 */
import {
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type PartialMessage,
} from "discord.js";
import type { Config } from "../config.js";
import type { Store } from "../core/db.js";
import { dm } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { TtlCache } from "../core/ttlCache.js";
import { SETUP } from "./parents.js";

const KEY = "commandsOnly";
const DM_COOLDOWN_MS = 6 * 3_600_000;
const NOTE_COOLDOWN_MS = 2 * 60_000;
const NOTE_LIFETIME_MS = 10_000;
const SWEEP_LIMIT = 100;

interface Settings {
  channels: Record<string, { enabledAt: number; by: string }>;
}

export function commandsOnlyChannels(store: Store): Settings["channels"] {
  return store.kvGet<Settings>(KEY)?.channels ?? {};
}

function isExempt(member: GuildMember | null | undefined, cfg: Config): boolean {
  if (!member) return false;
  if (member.guild?.ownerId === member.id) return true;
  if (cfg.adminRoleId && member.roles?.cache?.has(cfg.adminRoleId)) return true;
  return member.permissions?.has?.(PermissionFlagsBits.Administrator) ?? false;
}

export const commandsOnly: ModuleFactory = ({ cfg, store, client }) => {
  const dmed = new TtlCache<string, true>(DM_COOLDOWN_MS, 5000);
  const noted = new TtlCache<string, true>(NOTE_COOLDOWN_MS, 5000);
  let removed = 0;

  const settings = (): Settings => ({ channels: {}, ...(store.kvGet<Settings>(KEY) ?? {}) });

  /** The commands-only channel a message is in (threads count as their parent). */
  function watched(msg: Message | PartialMessage): { channelId: string; enabledAt: number } | undefined {
    const ch = settings().channels;
    const id = msg.channel?.isThread?.() ? (msg.channel.parentId ?? msg.channelId) : msg.channelId;
    const entry = ch[id];
    return entry ? { channelId: id, enabledAt: entry.enabledAt } : undefined;
  }

  async function shouldRemove(msg: Message): Promise<boolean> {
    if (!msg.guildId || msg.guildId !== cfg.guildId) return false;
    if (msg.author?.bot || msg.webhookId || msg.system || msg.pinned) return false;
    const w = watched(msg);
    if (!w || msg.createdTimestamp < w.enabledAt) return false;
    const member = msg.member ?? (msg.guild ? await msg.guild.members.fetch(msg.author.id).catch(() => null) : null);
    return !isExempt(member, cfg);
  }

  async function tellThem(msg: Message, channelId: string) {
    const userId = msg.author.id;
    if (dmed.has(userId)) return;
    dmed.set(userId, true);
    const sent = await dm(
      client,
      userId,
      `👋 Your message in <#${channelId}> was removed: that channel is just for bot commands.\n` +
        "Type **/** there to see them, like `/request` to ask for a movie or `/suggest` to share an idea. `/help` shows everything.",
    );
    if (sent || noted.has(userId)) return;
    noted.set(userId, true);
    // DMs closed: a short note in the channel that cleans itself up.
    const ch = msg.channel;
    if (!ch.isSendable()) return;
    const note = await ch
      .send({ content: `<@${userId}> this channel is just for bot commands, so your message was removed. Type **/** to see them.`, allowedMentions: { users: [userId] } })
      .catch(() => null);
    if (note) setTimeout(() => void note.delete().catch(() => undefined), NOTE_LIFETIME_MS).unref();
  }

  async function handle(msg: Message) {
    try {
      if (!(await shouldRemove(msg))) return;
      const w = watched(msg)!;
      await msg.delete();
      removed++;
      log.debug(`commands-only: removed a message from ${msg.author.id} in ${msg.channelId}`);
      await tellThem(msg, w.channelId);
    } catch (err) {
      log.warn(`commands-only: couldn't remove a message in ${msg.channelId} (does the bot have Manage Messages there?): ${(err as Error).message}`);
    }
  }

  client.on(Events.MessageCreate, (m) => void handle(m));

  /** After a restart: clean up what was posted while the bot was offline. */
  async function sweep() {
    for (const [channelId, entry] of Object.entries(settings().channels)) {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch || !("messages" in ch)) continue;
      const recent = await (ch as GuildTextBasedChannel).messages.fetch({ limit: SWEEP_LIMIT }).catch(() => null);
      if (!recent) continue;
      let n = 0;
      for (const msg of recent.values()) {
        if (msg.createdTimestamp < entry.enabledAt) continue;
        if (!(await shouldRemove(msg))) continue;
        if (await msg.delete().then(() => true).catch(() => false)) n++;
      }
      if (n) log.info(`commands-only: cleaned up ${n} message(s) posted in ${channelId} while the bot was offline`);
    }
  }

  /** Problems that would stop it working in this channel, in plain words. */
  function problems(channel: GuildTextBasedChannel): string[] {
    const out: string[] = [];
    const guild = channel.guild;
    const me = guild?.members?.me;
    const mine = me ? channel.permissionsFor(me) : null;
    if (mine) {
      if (!mine.has(PermissionFlagsBits.ViewChannel)) out.push("I can't see this channel. Give me **View Channel** there.");
      if (!mine.has(PermissionFlagsBits.ManageMessages)) out.push("I need **Manage Messages** here to remove messages. Add it to my role, or to this channel's permissions for me.");
      if (!mine.has(PermissionFlagsBits.ReadMessageHistory)) out.push("I need **Read Message History** here to clean up after a restart.");
    }
    const everyone = guild ? channel.permissionsFor(guild.roles.everyone) : null;
    if (everyone && !everyone.has(PermissionFlagsBits.SendMessages)) {
      out.push("Members can't type here, so they can't use / commands either. Turn **Send Messages** back on for @everyone in this channel.");
    }
    if (everyone && !everyone.has(PermissionFlagsBits.UseApplicationCommands)) out.push("Turn **Use Application Commands** on for @everyone here.");
    return out;
  }

  return {
    name: "commands-only",
    subcommands: [
      {
        ...SETUP,
        name: "commands-only",
        description: "Only allow / commands in a channel: other messages are removed",
        build: (b) =>
          b
            .addChannelOption((o) => o.setName("channel").setDescription("The channel").setRequired(true).addChannelTypes(ChannelType.GuildText))
            .addStringOption((o) =>
              o
                .setName("mode")
                .setDescription("On: remove anything that isn't a command. Off: back to normal")
                .setRequired(true)
                .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" }),
            ),
        execute: async (i) => {
          const picked = i.options.getChannel("channel", true);
          const on = i.options.getString("mode", true) === "on";
          const s = settings();
          if (!on) {
            delete s.channels[picked.id];
            store.kvSet(KEY, s);
            log.info(`commands-only: off for ${picked.id} (${i.user.id})`);
            return void (await i.reply({ content: `💬 <#${picked.id}> is back to normal.`, flags: MessageFlags.Ephemeral }));
          }
          s.channels[picked.id] = s.channels[picked.id] ?? { enabledAt: Date.now(), by: i.user.id };
          store.kvSet(KEY, s);
          log.info(`commands-only: on for ${picked.id} (${i.user.id})`);
          const ch = (await client.channels.fetch(picked.id).catch(() => null)) as GuildTextBasedChannel | null;
          const issues = ch && "permissionsFor" in ch ? problems(ch) : [];
          await i.reply({
            content:
              `🤖 <#${picked.id}> is now **commands-only**: members can use / commands, and anything else they type is removed straight away (they get a DM saying why). ` +
              "Admins and bots can still post, and earlier messages aren't touched." +
              (issues.length ? `\n\n⚠️ **To make it work:**\n${issues.map((x) => `• ${x}`).join("\n")}` : "") +
              "\n-# Tip: also turn on AutoMod in Server Settings to block swear words before they're ever posted.",
            flags: MessageFlags.Ephemeral,
          });
        },
      },
    ],
    start: () => {
      void sweep();
    },
    stop: () => {
      if (removed) log.info(`commands-only: removed ${removed} message(s) this run`);
    },
  };
};

