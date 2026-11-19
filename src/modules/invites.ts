/**
 * /invite create|list|revoke → Wizarr.
 *
 * Admins: any expiry/uses, see and revoke everything.
 * Inviters (INVITER_ROLE_ID): single-use links, expiry capped at
 * INVITER_EXPIRY_DAYS, at most INVITER_MAX_ACTIVE active at once, and they
 * only see/revoke their own. `user:@someone` DMs the link to that member.
 *
 * The bot only manages links; new users finish Wizarr's own browser wizard.
 * Wizarr identifies invites by code, so <name> is a nickname kept by the bot.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type BaseInteraction,
  type ChatInputCommandInteraction,
  type SendableChannels,
} from "discord.js";
import { Colors, dm, truncate, ts } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { inviteIsValid, wizarrDate, type WizarrInvitation } from "../services/wizarr.js";

const PARENT = { parent: "invite", parentDescription: "Plex invites (Wizarr)", gate: "inviter" } as const;

interface Row {
  inv: WizarrInvitation;
  name?: string;
  createdBy?: string;
  forUserId?: string;
}

export const invites: ModuleFactory = ({ services, store, cfg, client, access }) => {
  const wizarr = services.wizarr;
  if (!wizarr) return null;
  const limits = cfg.invites;

  async function audit(text: string) {
    if (!cfg.channels.admin) return;
    try {
      const ch = await client.channels.fetch(cfg.channels.admin);
      if (ch?.isSendable()) await (ch as SendableChannels).send({ content: text, allowedMentions: { parse: [] } });
    } catch (err) {
      log.warn(`invites: audit message failed: ${(err as Error).message}`);
    }
  }

  /** Every Wizarr invite joined with the bot's nicknames; stale nicknames are cleaned up. */
  async function rows(): Promise<Row[]> {
    const list = await wizarr!.invitations();
    const byId = new Map(list.map((inv) => [inv.id, inv]));
    const meta = new Map<number, { name: string; createdBy: string; forUserId?: string }>();
    for (const s of store.invites()) {
      if (byId.has(s.wizarrId)) meta.set(s.wizarrId, s);
      else store.deleteInvite(s.wizarrId);
    }
    return list.map((inv) => ({ inv, ...meta.get(inv.id) }));
  }

  /** Admins see everything; inviters only the invites they created. */
  const visible = (i: BaseInteraction, all: Row[]) => (access.isAdmin(i) ? all : all.filter((r) => r.createdBy === i.user.id));

  const expiryText = (inv: WizarrInvitation) => {
    const ms = wizarrDate(inv.expires);
    return ms ? `expires ${ts(ms)}` : "never expires";
  };

  async function create(i: ChatInputCommandInteraction) {
    const target = i.options.getUser("user");
    const name = (i.options.getString("name") ?? target?.username ?? "").trim();
    let expiry = i.options.getString("expiry");
    let uses = i.options.getString("uses") ?? "single";
    if (!name) {
      await i.reply({ content: "Give the invite a `name`, or pick a `user` to send it to.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (target?.bot) {
      await i.reply({ content: "Bots can't join Plex. 🙂 Pick a person.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const admin = access.isAdmin(i);
    const notes: string[] = [];
    const all = await rows();

    if (!admin) {
      if (uses !== "single") {
        uses = "single";
        notes.push("Inviter links are single use.");
      }
      const requested = expiry && expiry !== "never" ? Number(expiry) : Infinity;
      if (requested > limits.expiryDays) {
        if (expiry) notes.push(`Inviter links expire after at most ${limits.expiryDays} day${limits.expiryDays === 1 ? "" : "s"}.`);
        expiry = String(limits.expiryDays);
      }
      const mine = all.filter((r) => r.createdBy === i.user.id && inviteIsValid(r.inv));
      if (limits.maxActive > 0 && mine.length >= limits.maxActive) {
        await i.editReply(
          `You already have ${mine.length} active invite${mine.length === 1 ? "" : "s"} (the limit is ${limits.maxActive}): ` +
            `${mine.map((r) => `**${r.name ?? r.inv.code}**`).join(", ")}. Revoke one with \`/invite revoke\` or wait for it to be used or expire.`,
        );
        return;
      }
    }

    const clash = all.find((r) => r.name?.toLowerCase() === name.toLowerCase());
    if (clash && inviteIsValid(clash.inv)) {
      await i.editReply(`There's already an active invite called **${name}** (\`${clash.inv.code}\`). Revoke it first or use another name.`);
      return;
    }
    if (clash) store.deleteInvite(clash.inv.id);

    const days = !expiry || expiry === "never" ? undefined : (Number(expiry) as 1 | 7 | 30);
    const inv = await wizarr!.createInvitation({ expiresInDays: days, unlimited: uses === "unlimited" });
    store.saveInvite({ name, wizarrId: inv.id, code: inv.code, createdBy: i.user.id, createdAt: Date.now(), forUserId: target?.id });
    const url = wizarr!.inviteLink(inv);
    const expiresMs = wizarrDate(inv.expires);
    const linkRow = /^https:\/\//.test(url)
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel("Open invite"))]
      : [];

    let delivery = "";
    if (target) {
      const sent = await dm(client, target.id, {
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.plex)
            .setTitle(`🎟️ You're invited to ${truncate(i.guild?.name ?? "our", 80)}'s Plex`)
            .setDescription(
              `<@${i.user.id}> sent you an invite. Open the link and follow the steps: it takes a couple of minutes, and you'll need a free Plex account.\n\n${url}`,
            )
            .addFields(
              { name: "Link works", value: expiresMs ? `until ${ts(expiresMs, "f")}` : "until it's used", inline: true },
              { name: "Uses", value: inv.unlimited ? "Unlimited" : "Just you (single use)", inline: true },
            ),
        ],
        components: linkRow,
      });
      delivery = sent
        ? `📬 Sent to <@${target.id}> by DM.`
        : `⚠️ I couldn't DM <@${target.id}> (they probably have DMs from server members turned off). Pass this link along yourself:`;
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.ok)
      .setTitle(`🎟️ Invite "${truncate(name, 60)}" created`)
      .setDescription([delivery, target ? url : `Send this link to your friend. Wizarr walks them through joining Plex:\n${url}`].filter(Boolean).join("\n"))
      .addFields(
        { name: "Code", value: `\`${inv.code}\``, inline: true },
        { name: "Uses", value: inv.unlimited ? "Unlimited" : "Single use", inline: true },
        { name: "Expiry", value: expiresMs ? ts(expiresMs) : "Never", inline: true },
      );
    if (notes.length) embed.addFields({ name: "Note", value: notes.join(" ") });
    if (!wizarr!.hasPublicUrl) embed.setFooter({ text: "WIZARR_PUBLIC_URL isn't set, so this link uses the internal address." });
    await i.editReply({ embeds: [embed], components: linkRow });
    await audit(
      `🎟️ <@${i.user.id}> created invite **${name}** (\`${inv.code}\`, ${inv.unlimited ? "unlimited uses" : "single use"}, ${expiryText(inv)})` +
        `${target ? ` for <@${target.id}>` : ""}.`,
    );
  }

  async function list(i: ChatInputCommandInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const mine = visible(i, await rows());
    const active = mine.filter((r) => inviteIsValid(r.inv));
    const inactive = mine.length - active.length;
    const scope = access.isAdmin(i) ? "" : " of yours";
    if (!active.length) {
      await i.editReply(`No active invites${scope}.${inactive ? ` (${inactive} used or expired hidden.)` : ""} Create one with \`/invite create\`.`);
      return;
    }
    const admin = access.isAdmin(i);
    const lines = active
      .sort((a, b) => (wizarrDate(a.inv.expires) ?? Infinity) - (wizarrDate(b.inv.expires) ?? Infinity))
      .map((r) => {
        const who = [r.forUserId ? `for <@${r.forUserId}>` : "", admin && r.createdBy ? `by <@${r.createdBy}>` : ""].filter(Boolean).join(" ");
        return (
          `✅ **${r.name ?? r.inv.code}**${r.name ? ` · \`${r.inv.code}\`` : ""} · ${r.inv.unlimited ? "unlimited uses" : "1 use left"} · ${expiryText(r.inv)}` +
          `${who ? ` · ${who}` : ""}\n${wizarr!.inviteLink(r.inv)}`
        );
      });
    const embed = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle(`🎟️ ${active.length} active invite${active.length === 1 ? "" : "s"}${scope}`)
      .setDescription(truncate(lines.join("\n\n"), 4000));
    const foot = [inactive ? `${inactive} used or expired not shown` : "", !admin && limits.maxActive ? `limit: ${limits.maxActive} active` : ""].filter(Boolean).join(" · ");
    if (foot) embed.setFooter({ text: foot });
    await i.editReply({ embeds: [embed] });
  }

  async function revoke(i: ChatInputCommandInteraction) {
    const input = i.options.getString("name", true).trim().toLowerCase();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const mine = visible(i, await rows());
    const hit =
      mine.find((r) => r.name?.toLowerCase() === input) ?? mine.find((r) => r.inv.code.toLowerCase() === input) ?? mine.find((r) => String(r.inv.id) === input);
    if (!hit) {
      await i.editReply(`No invite${access.isAdmin(i) ? "" : " of yours"} called **${truncate(input, 60)}**. \`/invite list\` shows them.`);
      return;
    }
    await wizarr!.deleteInvitation(hit.inv.id);
    store.deleteInvite(hit.inv.id);
    const label = hit.name ? `**${hit.name}** (\`${hit.inv.code}\`)` : `\`${hit.inv.code}\``;
    await i.editReply(`🗑️ Revoked invite ${label}. The link no longer works.`);
    await audit(`🗑️ <@${i.user.id}> revoked invite ${label}.`);
  }

  async function autocomplete(i: AutocompleteInteraction) {
    const typed = i.options.getFocused().toLowerCase();
    const choices = visible(i, await rows())
      .filter((r) => inviteIsValid(r.inv))
      .map((r) => ({ name: truncate(r.name ? `${r.name} (${r.inv.code})` : r.inv.code, 100), value: r.name ?? r.inv.code }))
      .filter((c) => c.name.toLowerCase().includes(typed))
      .slice(0, 25);
    await i.respond(choices);
  }

  return {
    name: "invites",
    subcommands: [
      {
        ...PARENT,
        name: "create",
        description: "Create a Wizarr invite link (pick a user to DM it to them)",
        build: (b) =>
          b
            .addUserOption((o) => o.setName("user").setDescription("Send the link to this member by DM"))
            .addStringOption((o) => o.setName("name").setDescription("Nickname to find it later (defaults to the user's name)").setMaxLength(40))
            .addStringOption((o) =>
              o
                .setName("expiry")
                .setDescription("When the link stops working")
                .addChoices({ name: "1 day", value: "1" }, { name: "7 days", value: "7" }, { name: "30 days", value: "30" }, { name: "Never", value: "never" }),
            )
            .addStringOption((o) =>
              o.setName("uses").setDescription("How many people can use it (default: single use)").addChoices({ name: "Single use", value: "single" }, { name: "Unlimited", value: "unlimited" }),
            ),
        execute: create,
      },
      { ...PARENT, name: "list", description: "Show active invites (inviters see their own)", execute: list },
      {
        ...PARENT,
        name: "revoke",
        description: "Delete an invite so its link stops working",
        build: (b) => b.addStringOption((o) => o.setName("name").setDescription("Invite nickname or code").setRequired(true).setAutocomplete(true)),
        execute: revoke,
        autocomplete,
      },
    ],
  };
};
