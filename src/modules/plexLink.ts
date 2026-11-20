/**
 * /plex link · status · unlink: connect a member's Discord to their Plex
 * account. Linking signs them in once through plex.tv and confirms the
 * account is on our server's share list. Their Plex token is never stored.
 *
 * Admin: /plex linked lists who's linked; /plex remove @user unlinks someone.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { Colors, truncate, ts } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { RedownloadStore } from "../redownload/store.js";
import { plexTvFor } from "../services/plextv.js";

const PIN_WAIT_MS = 10 * 60_000;
const POLL_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const plexLink: ModuleFactory = (ctx) => {
  const { store } = ctx;
  const maybe = plexTvFor(ctx);
  if (!maybe) return null;
  const plexTv = maybe;
  const rstore = new RedownloadStore(store);
  const pending = new Map<string, number>(); // discord id → attempt number (a newer /plex link cancels the older one)

  async function link(i: ChatInputCommandInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const attempt = (pending.get(i.user.id) ?? 0) + 1;
    pending.set(i.user.id, attempt);
    const pin = await plexTv.createPin();
    const url = plexTv.authUrl(pin.code);
    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.plex)
          .setTitle("🔗 Link your Plex account")
          .setDescription(
            "Tap **Sign in with Plex** and log in with the Plex account you use to watch here. This message updates by itself once you're done.\n\n" +
              "*The link is just for you and expires in 10 minutes. I only read your Plex username and account number; I never keep your Plex sign-in.*",
          ),
      ],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel("Sign in with Plex"))],
    });

    const deadline = Date.now() + PIN_WAIT_MS;
    let token: string | undefined;
    while (Date.now() < deadline && pending.get(i.user.id) === attempt) {
      await sleep(POLL_MS);
      token = await plexTv.pinToken(pin.id).catch(() => undefined);
      if (token) break;
    }
    if (pending.get(i.user.id) !== attempt) return; // superseded by a newer /plex link
    pending.delete(i.user.id);
    if (!token) {
      await i.editReply({ content: "⌛ The sign-in link expired. Run `/plex link` again when you're ready.", embeds: [], components: [] });
      return;
    }

    const account = await plexTv.account(token);
    token = undefined; // done with it
    const other = rstore.linkByPlexId(account.id);
    if (other && other.discordUserId !== i.user.id) {
      await i.editReply({
        content: `⚠️ The Plex account **${account.username}** is already linked to another Discord member. Ask an admin if that's wrong.`,
        embeds: [],
        components: [],
      });
      log.warn(`plex: ${i.user.id} tried to link Plex account ${account.id}, already linked to ${other.discordUserId}`);
      return;
    }
    plexTv.forgetCache(); // a fresh look, in case they were invited a minute ago
    const access = await plexTv.hasAccess(account.id);
    rstore.saveLink({ discordUserId: i.user.id, plexUserId: account.id, plexUsername: account.username, hasAccess: access, linkedAt: Date.now(), verifiedAt: Date.now() });
    log.info(`plex: ${i.user.id} linked to Plex ${account.username} (${account.id}), access=${access}`);
    await i.editReply({
      content: "",
      components: [],
      embeds: [
        new EmbedBuilder()
          .setColor(access ? Colors.ok : Colors.warn)
          .setTitle(access ? `✅ Linked to ${account.username}` : `🔗 Linked to ${account.username}, but…`)
          .setDescription(
            access
              ? "Your Plex account is confirmed on our server. You can now use `/redownload` to replace broken files yourself."
              : "That Plex account isn't on our server's share list, so features that need a confirmed account stay locked. If you were just invited, finish joining first, then run `/plex link` again.",
          ),
      ],
    });
  }

  async function status(i: ChatInputCommandInteraction) {
    const l = rstore.link(i.user.id);
    await i.reply({
      content: l
        ? `🔗 Linked to Plex account **${l.plexUsername}** since ${ts(l.linkedAt, "d")}. Server access: ${l.hasAccess ? "✅ confirmed" : "❌ not on the share list"} (checked ${ts(l.verifiedAt)}).`
        : "You haven't linked a Plex account yet. Run `/plex link`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  async function unlink(i: ChatInputCommandInteraction) {
    rstore.deleteLink(i.user.id);
    await i.reply({ content: "🔓 Your Plex account is no longer linked.", flags: MessageFlags.Ephemeral });
  }

  const PARENT = { parent: "plex", parentDescription: "Link your Plex account to Discord" } as const;
  return {
    name: "plex-link",
    subcommands: [
      { ...PARENT, name: "link", description: "Link your Plex account (one quick sign-in)", execute: link },
      { ...PARENT, name: "status", description: "Which Plex account you're linked to", execute: status },
      { ...PARENT, name: "unlink", description: "Unlink your Plex account", execute: unlink },
      {
        ...PARENT,
        name: "linked",
        gate: "admin",
        description: "Admin: list members with a linked Plex account",
        execute: async (i) => {
          const all = rstore.links();
          const lines = all.map((l) => `${l.hasAccess ? "✅" : "❌"} <@${l.discordUserId}> → **${l.plexUsername}** · checked ${ts(l.verifiedAt)}`);
          await i.reply({
            embeds: [new EmbedBuilder().setColor(Colors.info).setTitle(`🔗 ${all.length} linked member${all.length === 1 ? "" : "s"}`).setDescription(truncate(lines.join("\n") || "Nobody yet.", 4000))],
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        },
      },
      {
        ...PARENT,
        name: "remove",
        gate: "admin",
        description: "Admin: unlink someone's Plex account",
        build: (b) => b.addUserOption((o) => o.setName("user").setDescription("Member to unlink").setRequired(true)),
        execute: async (i) => {
          const u = i.options.getUser("user", true);
          rstore.deleteLink(u.id);
          await i.reply({ content: `🔓 Unlinked <@${u.id}>'s Plex account.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        },
      },
    ],
  };
};

