/**
 * Opt-in panel: button toggles for Movies / TV / Music / Server status roles.
 *  - /optin setup channel:#welcome (admin) creates any missing roles and posts the panel
 *  - /optin me shows the same toggles privately, with your current state
 * Roles drive @-pings in announcements; the Music role also unlocks music features.
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
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { OPT_CATEGORIES, type OptCategory } from "../core/roles.js";

const PANEL_KEY = "optin.panel";
const ROLE_NAMES: Record<OptCategory, string> = { movies: "Movies", tv: "TV", music: "Music", status: "Server status" };

export const optin: ModuleFactory = ({ roles, store, cfg }) => {
  function panelEmbed(member?: GuildMember) {
    const lines = OPT_CATEGORIES.map((c) => {
      const roleId = roles.get(c.key);
      const on = member && roleId ? member.roles.cache.has(roleId) : undefined;
      const state = on === undefined ? "" : on ? " · ✅ on" : " · off";
      return `${c.emoji} **${c.name}**${state}\n${c.blurb}`;
    });
    return new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle(member ? "🔔 Your notification settings" : "🔔 Pick what you're into")
      .setDescription(
        `${lines.join("\n\n")}\n\nTap a button to switch it on or off.${member ? "" : " Only you see the confirmation."}\n` +
          "*Requests you make yourself always @ you when they're ready, whatever you pick here.*",
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

  async function me(i: ChatInputCommandInteraction) {
    const member = await i.guild!.members.fetch(i.user.id);
    await i.reply({ embeds: [panelEmbed(member)], components: [buttons("e", member)], flags: MessageFlags.Ephemeral });
  }

  async function setup(i: ChatInputCommandInteraction) {
    const channel = i.options.getChannel("channel", true);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = i.guild!;
    const created: string[] = [];
    try {
      for (const c of OPT_CATEGORIES) {
        const current = roles.get(c.key);
        if (current && (await guild.roles.fetch(current).catch(() => null))) continue;
        const existing = guild.roles.cache.find((r) => r.name.toLowerCase() === ROLE_NAMES[c.key].toLowerCase());
        const role =
          existing ??
          (await guild.roles.create({
            name: ROLE_NAMES[c.key],
            // Mentionable so the bot can ping it without the "Mention Everyone" permission.
            mentionable: true,
            reason: `MediaHub opt-in role (${c.blurb})`,
          }));
        roles.set(c.key, role.id);
        if (!existing) created.push(role.name);
      }
    } catch (err) {
      if (discordErrorCode(err) === DiscordCodes.MissingPermissions) {
        await i.editReply("⚠️ I need the **Manage Roles** permission to create the opt-in roles. Grant it, then run this again.");
        return;
      }
      throw err;
    }

    const target = await guild.channels.fetch(channel.id);
    if (!target?.isSendable()) {
      await i.editReply(`⚠️ I can't post in <#${channel.id}>. Give me View Channel and Send Messages there.`);
      return;
    }
    const old = store.kvGet<{ channelId: string; messageId: string }>(PANEL_KEY);
    const msg = await target.send({ embeds: [panelEmbed()], components: [buttons("p")] });
    store.kvSet(PANEL_KEY, { channelId: msg.channelId, messageId: msg.id });
    if (old) {
      const oldCh = await guild.channels.fetch(old.channelId).catch(() => null);
      if (oldCh?.isTextBased()) await oldCh.messages.delete(old.messageId).catch(() => undefined);
    }

    const notes = [
      `✅ Opt-in panel posted in <#${msg.channelId}>.`,
      created.length ? `Created roles: ${created.join(", ")}.` : "Using the existing roles.",
      "Make sure my role sits **above** these roles in Server Settings → Roles, or I can't hand them out.",
      cfg.channels.music ? "" : "Tip: set MUSIC_NOTIFY_CHANNEL_ID to a channel only the Music role can see, so people who opt out of music don't see album announcements at all.",
    ].filter(Boolean);
    await i.editReply(notes.join("\n"));
  }

  async function toggle(i: MessageComponentInteraction) {
    const [, cat, scope] = i.customId.split(":") as [string, OptCategory, "p" | "e"];
    const meta = OPT_CATEGORIES.find((c) => c.key === cat);
    const roleId = roles.get(cat);
    if (!meta || !roleId) {
      await i.reply({ content: "This option isn't set up yet. Ask an admin to run `/optin setup`.", flags: MessageFlags.Ephemeral });
      return;
    }
    const member = await i.guild!.members.fetch(i.user.id);
    const on = member.roles.cache.has(roleId);
    try {
      if (on) await member.roles.remove(roleId, "Opt-in panel");
      else await member.roles.add(roleId, "Opt-in panel");
    } catch (err) {
      const code = discordErrorCode(err);
      log.warn(`optin: could not toggle ${cat} for ${i.user.id}: ${(err as Error).message}`);
      const msg =
        code === DiscordCodes.MissingPermissions
          ? "⚠️ I'm not allowed to change that role. An admin needs to move my role above it (Server Settings → Roles)."
          : "⚠️ Couldn't change that role. Try again in a moment.";
      await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
      return;
    }
    const fresh = await i.guild!.members.fetch({ user: i.user.id, force: true });
    if (scope === "e") {
      await i.update({ embeds: [panelEmbed(fresh)], components: [buttons("e", fresh)] });
    } else {
      const extra = cat === "music" && !on ? " `/request album` and `/music` are now unlocked." : "";
      await i.reply({
        content: `${meta.emoji} **${meta.name}** is now **${on ? "off" : "on"}** for you.${extra} Use \`/optin me\` to see everything.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  return {
    name: "optin",
    subcommands: [
      {
        parent: "optin",
        parentDescription: "Choose what you get pinged for",
        name: "me",
        description: "See and change your notification and music opt-ins",
        execute: me,
      },
      {
        parent: "optin",
        parentDescription: "Choose what you get pinged for",
        name: "setup",
        gate: "admin",
        description: "Admin: create the opt-in roles and post the button panel",
        build: (b) =>
          b.addChannelOption((o) =>
            o.setName("channel").setDescription("Where to post the panel (e.g. #welcome)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true),
          ),
        execute: setup,
      },
    ],
    components: { optin: toggle },
  };
};
