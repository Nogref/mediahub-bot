/**
 * /plex: connect a member's Discord to their Plex account. Not linked yet →
 * it starts the sign-in straight away. Linked → shows the account with
 * Unlink / Link a different account buttons. Linking signs in once through
 * plex.tv and checks the account is on the server's share list. Their Plex
 * token is never stored.
 *
 * Admin: /admin plex linked · /admin plex unlink @user
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
import { Colors, truncate, ts } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { RedownloadStore } from "../redownload/store.js";
import { plexTvFor } from "../services/plextv.js";
import { ADMIN } from "./parents.js";

const PIN_WAIT_MS = 10 * 60_000;
const POLL_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GROUP = { name: "plex", description: "Who's linked their Plex account" };

export const plexLink: ModuleFactory = (ctx) => {
  const { store } = ctx;
  const maybe = plexTvFor(ctx);
  if (!maybe) return null;
  const plexTv = maybe;
  const rstore = new RedownloadStore(store);
  const pending = new Map<string, number>(); // discord id → attempt number (a newer sign-in cancels the older one)

  /** Works from the /plex command and from its "Link" button. */
  async function link(i: ChatInputCommandInteraction | MessageComponentInteraction) {
    if (i.isChatInputCommand()) await i.deferReply({ flags: MessageFlags.Ephemeral });
    else await i.deferUpdate();
    const attempt = (pending.get(i.user.id) ?? 0) + 1;
    pending.set(i.user.id, attempt);
    const pin = await plexTv.createPin();
    const url = plexTv.authUrl(pin.code);
    await i.editReply({
      content: "",
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
    if (pending.get(i.user.id) !== attempt) return; // superseded by a newer sign-in
    pending.delete(i.user.id);
    if (!token) {
      await i.editReply({ content: "⌛ The sign-in link expired. Run `/plex` again when you're ready.", embeds: [], components: [] });
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
              ? "Your Plex account is confirmed on our server. You're all set."
              : "That Plex account isn't on our server's share list. If you were just invited, accept the invite first, then run `/plex` again.",
          ),
      ],
    });
  }

  function linkedCard(userId: string) {
    const l = rstore.link(userId)!;
    return {
      content: "",
      embeds: [
        new EmbedBuilder()
          .setColor(l.hasAccess ? Colors.ok : Colors.warn)
          .setTitle(`🔗 Linked to ${l.plexUsername}`)
          .setDescription(
            `Linked ${ts(l.linkedAt, "d")}. ${l.hasAccess ? "✅ Confirmed on our server." : "❌ This account isn't on our server's share list."}` +
              `\n-# Last checked ${ts(l.verifiedAt)}`,
          ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("plexl:relink").setLabel("Link a different account").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("plexl:unlink").setLabel("Unlink").setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }

  return {
    name: "plex-link",
    commands: [
      {
        name: "plex",
        description: "Link your Plex account to Discord (or see which one is linked)",
        execute: async (i) => {
          if (!rstore.link(i.user.id)) return link(i);
          await i.reply({ ...linkedCard(i.user.id), flags: MessageFlags.Ephemeral });
        },
      },
    ],
    components: {
      plexl: async (i) => {
        const action = i.customId.split(":")[1];
        if (action === "relink") return link(i);
        if (action === "unlink") {
          rstore.deleteLink(i.user.id);
          log.info(`plex: ${i.user.id} unlinked their Plex account`);
          await i.update({ content: "🔓 Unlinked. Run `/plex` anytime to link again.", embeds: [], components: [] });
        }
      },
    },
    subcommands: [
      {
        ...ADMIN,
        group: GROUP,
        name: "linked",
        description: "List members with a linked Plex account",
        execute: async (i) => {
          const all = rstore.links();
          const lines = all.map((l) => `${l.hasAccess ? "✅" : "❌"} <@${l.discordUserId}> → **${l.plexUsername}** · checked ${ts(l.verifiedAt)}`);
          await i.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.info)
                .setTitle(`🔗 ${all.length} linked member${all.length === 1 ? "" : "s"}`)
                .setDescription(truncate(lines.join("\n") || "Nobody yet.", 4000)),
            ],
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        },
      },
      {
        ...ADMIN,
        group: GROUP,
        name: "unlink",
        description: "Unlink someone's Plex account",
        build: (b) => b.addUserOption((o) => o.setName("user").setDescription("Member to unlink").setRequired(true)),
        execute: async (i) => {
          const u = i.options.getUser("user", true);
          rstore.deleteLink(u.id);
          log.info(`plex: ${i.user.id} unlinked ${u.id}'s Plex account`);
          await i.reply({ content: `🔓 Unlinked <@${u.id}>'s Plex account.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        },
      },
    ],
  };
};
