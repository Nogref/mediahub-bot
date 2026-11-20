/**
 * Ping settings: Movies / TV / Music / Server status roles, toggled with
 * buttons. Only controls who gets @-pinged; every feature stays open to all.
 *  - /pings                        your settings, privately
 *  - "🔔 Ping settings" button     on the welcome post (opens the same thing)
 *  - /setup pings channel:#x       (admin) standalone public panel
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type GuildMember,
  type MessageComponentInteraction,
} from "discord.js";
import { Colors, DiscordCodes, discordErrorCode } from "../core/discord.js";
import { LiveMessage } from "../core/liveMessage.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { OPT_CATEGORIES, type OptCategory } from "../core/roles.js";
import { SETUP } from "./parents.js";

export const ROLE_PERMISSION_HELP =
  "I need the **Manage Roles** permission, and my role has to sit **above** the ping roles in Server Settings → Roles.";

export const pings: ModuleFactory = ({ roles, store, client }) => {
  const panel = new LiveMessage(client, store, "pings-panel");

  function embed(member?: GuildMember) {
    const lines = OPT_CATEGORIES.map((c) => {
      const roleId = roles.get(c.key);
      const on = member && roleId ? member.roles.cache.has(roleId) : undefined;
      return `${c.emoji} **${c.name}**${on === undefined ? "" : on ? " · ✅ on" : " · off"}\n${c.blurb}`;
    });
    return new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle(member ? "🔔 Your ping settings" : "🔔 Choose what pings you")
      .setDescription(
        `${lines.join("\n\n")}\n\nTap to switch each one on or off.\n` +
          "*Everything (requests, music, Aurral) works for everyone either way, and your own requests always ping you when they're ready.*",
      );
  }

  function buttons(scope: "p" | "e", member?: GuildMember) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      OPT_CATEGORIES.map((c) => {
        const roleId = roles.get(c.key);
        const on = Boolean(member && roleId && member.roles.cache.has(roleId));
        return new ButtonBuilder()
          .setCustomId(`optin:${c.key}:${scope}`)
          .setEmoji(c.emoji)
          .setLabel(member ? `${c.name}${on ? " ✓" : ""}` : c.name)
          .setStyle(member && on ? ButtonStyle.Success : ButtonStyle.Secondary);
      }),
    );
  }

  /** The private settings view (used by /pings and the welcome post's button). */
  async function showPrivate(i: ChatInputCommandInteraction | MessageComponentInteraction) {
    if (OPT_CATEGORIES.some((c) => !roles.get(c.key))) {
      try {
        await roles.ensure(i.guild!);
      } catch (err) {
        log.warn(`pings: couldn't create ping roles: ${(err as Error).message}`);
        await i.reply({ content: `Ping settings aren't set up yet. ${ROLE_PERMISSION_HELP}`, flags: MessageFlags.Ephemeral });
        return;
      }
    }
    const member = await i.guild!.members.fetch(i.user.id);
    await i.reply({ embeds: [embed(member)], components: [buttons("e", member)], flags: MessageFlags.Ephemeral });
  }

  async function setupPanel(i: ChatInputCommandInteraction) {
    const channel = i.options.getChannel("channel", true);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let created: string[];
    try {
      created = await roles.ensure(i.guild!);
    } catch (err) {
      if (discordErrorCode(err) === DiscordCodes.MissingPermissions) return void (await i.editReply(`⚠️ ${ROLE_PERMISSION_HELP}`));
      throw err;
    }
    const msg = await panel.place(channel.id, { embeds: [embed()], components: [buttons("p")] });
    await i.editReply(
      [`✅ Ping panel posted in <#${msg.channelId}>.`, created.length ? `Created roles: ${created.join(", ")}.` : "", ROLE_PERMISSION_HELP]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async function toggle(i: MessageComponentInteraction) {
    const [, cat, scope] = i.customId.split(":") as [string, OptCategory | "open", "p" | "e"];
    if (cat === "open") return showPrivate(i);
    const meta = OPT_CATEGORIES.find((c) => c.key === cat);
    const roleId = roles.get(cat);
    if (!meta || !roleId) {
      await i.reply({ content: "Ping settings aren't set up yet. Ask an admin to run `/setup welcome` or `/setup pings`.", flags: MessageFlags.Ephemeral });
      return;
    }
    const member = await i.guild!.members.fetch(i.user.id);
    const on = member.roles.cache.has(roleId);
    try {
      if (on) await member.roles.remove(roleId, "Ping settings");
      else await member.roles.add(roleId, "Ping settings");
    } catch (err) {
      log.warn(`pings: could not toggle ${cat} for ${i.user.id}: ${(err as Error).message}`);
      const msg = discordErrorCode(err) === DiscordCodes.MissingPermissions ? `⚠️ ${ROLE_PERMISSION_HELP}` : "⚠️ Couldn't change that. Try again in a moment.";
      await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
      return;
    }
    const fresh = await i.guild!.members.fetch({ user: i.user.id, force: true });
    if (scope === "e") {
      await i.update({ embeds: [embed(fresh)], components: [buttons("e", fresh)] });
    } else {
      await i.reply({ content: `${meta.emoji} **${meta.name}** pings are now **${on ? "off" : "on"}** for you. \`/pings\` shows all your settings.`, flags: MessageFlags.Ephemeral });
    }
  }

  return {
    name: "pings",
    commands: [{ name: "pings", description: "Choose which announcements @-ping you", execute: showPrivate }],
    subcommands: [
      {
        parent: "setup",
        parentDescription: SETUP.parentDescription,
        gate: "admin",
        name: "pings",
        description: "Post a standalone ping-settings panel (the welcome post has one built in)",
        build: (b) =>
          b.addChannelOption((o) => o.setName("channel").setDescription("Where to post it").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
        execute: setupPanel,
      },
    ],
    components: { optin: toggle },
  };
};
