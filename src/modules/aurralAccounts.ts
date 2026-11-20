/**
 * Aurral accounts from Discord. Aurral has no invite links, but its admin API
 * can create users, so:
 *  - /aurral [username]                       anyone: makes your account (login by DM), or shows it
 *  - /invite aurral user:@x [username]        inviters/admins: makes one for someone else and DMs them
 *  - /admin aurral link user:@x username:…    admins: connect an existing Aurral account
 * One account per Discord member. The password also works in Subsonic apps.
 * Aurral's API can't reset someone else's password with an API key, so
 * forgotten passwords are reset by an admin in Aurral (Settings → Users).
 */
import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type User } from "discord.js";
import { randomInt } from "node:crypto";
import { Colors, dm } from "../core/discord.js";
import { ApiError } from "../core/http.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { ADMIN, INVITE } from "./parents.js";

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes

export function generatePassword(length = 16): string {
  return Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

/** Discord name → something Aurral-friendly: lowercase letters, digits, dot, dash, underscore. */
export function toUsername(raw: string): string {
  const u = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32);
  return u.length >= 2 ? u : "";
}

export const aurralAccounts: ModuleFactory = ({ services, store, cfg, client }) => {
  const aurral = services.aurral;
  if (!aurral) return null;

  const address = () => cfg.links.aurral ?? aurral.url;

  function loginEmbed(username: string, password?: string) {
    const e = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle("🎵 Your Aurral account")
      .setDescription(
        [
          `**Open:** ${address()}`,
          `**Username:** \`${username}\``,
          password ? `**Password:** ||\`${password}\`|| (tap to reveal)` : "",
          "",
          "**Change your password** in Aurral → Settings → Profile.",
          "**On your phone or computer:** any Subsonic app works (Aurral's docs mention Feishin). Use the same address, username and password. Or open music.aurral.org and enter our address.",
          "**Forgot your password?** Ask an admin to reset it in Aurral → Settings → Users.",
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
    if (!cfg.links.aurral) e.setFooter({ text: "Admins: set the public address with /setup links aurral:https://…" });
    return e;
  }

  async function createFor(i: ChatInputCommandInteraction, target: User, requested?: string) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const self = target.id === i.user.id;
    const existing = store.aurralAccount(target.id);
    if (existing) {
      await i.editReply(
        self
          ? { content: "", embeds: [loginEmbed(existing.username)] }
          : { content: `<@${target.id}> already has an Aurral account (\`${existing.username}\`).`, allowedMentions: { parse: [] } },
      );
      return;
    }
    const username = toUsername(requested ?? target.username);
    if (!username) {
      await i.editReply("Pick a username with letters or numbers (2–32 characters), e.g. `username:alex`.");
      return;
    }
    const password = generatePassword();
    let created;
    try {
      created = await aurral!.createUser(username, password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await i.editReply(
          `There's already an Aurral account called \`${username}\`. If it's ${self ? "yours" : "theirs"}, an admin can connect it with \`/admin aurral link\`; otherwise pick another name with \`username:\`.`,
        );
        return;
      }
      throw err;
    }
    store.saveAurralAccount(target.id, created.id, created.username ?? username, i.user.id);
    log.info(`aurral: created account "${username}" for Discord user ${target.id} (by ${i.user.id})`);

    const sent = await dm(client, target.id, {
      content: self ? undefined : `<@${i.user.id}> set you up with an Aurral account for the music library.`,
      embeds: [loginEmbed(created.username ?? username, password)],
    });
    if (sent) {
      await i.editReply(self ? "📬 Done! I've sent your login in a DM." : `📬 Created \`${username}\` and sent the login to <@${target.id}> by DM.`);
    } else if (self) {
      // DMs closed: this reply is private, so it's safe to show here.
      await i.editReply({ content: "Your DMs are closed, so here's your login (only you can see this):", embeds: [loginEmbed(created.username ?? username, password)] });
    } else {
      await i.editReply({
        content: `Created \`${username}\`, but <@${target.id}> has DMs closed. Pass this on privately:`,
        embeds: [loginEmbed(created.username ?? username, password)],
        allowedMentions: { parse: [] },
      });
    }
  }

  return {
    name: "aurral-accounts",
    commands: [
      {
        name: "aurral",
        description: "Your own music streaming account: sign up, or see your login",
        build: (b) => b.addStringOption((o) => o.setName("username").setDescription("Only when signing up. Defaults to your Discord username").setMaxLength(32)),
        execute: (i) => createFor(i, i.user, i.options.getString("username") ?? undefined),
      },
    ],
    subcommands: [
      {
        ...INVITE,
        name: "aurral",
        description: "Make someone a music (Aurral) account and DM them the login",
        build: (b) =>
          b
            .addUserOption((o) => o.setName("user").setDescription("Who it's for").setRequired(true))
            .addStringOption((o) => o.setName("username").setDescription("Optional. Defaults to their Discord username").setMaxLength(32)),
        execute: async (i) => {
          const target = i.options.getUser("user", true);
          if (target.bot) return void (await i.reply({ content: "Bots don't need music. 🙂", flags: MessageFlags.Ephemeral }));
          await createFor(i, target, i.options.getString("username") ?? undefined);
        },
      },
      {
        ...ADMIN,
        group: { name: "aurral", description: "Music (Aurral) accounts" },
        name: "link",
        description: "Connect an existing Aurral account to a member",
        build: (b) =>
          b
            .addUserOption((o) => o.setName("user").setDescription("The member").setRequired(true))
            .addStringOption((o) => o.setName("username").setDescription("Their existing Aurral username").setRequired(true).setMaxLength(64)),
        execute: async (i) => {
          const target = i.options.getUser("user", true);
          const wanted = i.options.getString("username", true).trim().toLowerCase();
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const user = (await aurral!.users()).find((u) => u.username.toLowerCase() === wanted);
          if (!user) return void (await i.editReply(`No Aurral account called \`${wanted}\`.`));
          store.saveAurralAccount(target.id, user.id, user.username, i.user.id);
          await i.editReply({ content: `🔗 <@${target.id}> is now linked to the Aurral account \`${user.username}\`.`, allowedMentions: { parse: [] } });
        },
      },
    ],
  };
};
