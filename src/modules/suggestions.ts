/**
 * /suggest: members share ideas without anyone needing to type in a channel.
 * A short form → a family-friendly check → the bot posts it in the
 * suggestions channel (read-only for members) with a 👍 vote button. Admins
 * set a status (looking into it / done / not planned) with an optional note,
 * and the member gets a DM.
 *
 * Text the filter catches isn't posted; the member can reword it or send it to
 * the admins privately, who can still publish it (the filter is cautious, so
 * titles like "Moby Dick" get caught too). `/admin suggestions review on`
 * sends every suggestion to the admins first.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type SendableChannels,
} from "discord.js";
import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from "obscenity";
import { Colors, dm, truncate } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { TtlCache } from "../core/ttlCache.js";
import { ADMIN } from "./parents.js";

const DAILY_LIMIT = 3;
const SETTINGS_KEY = "suggestions.settings";

type Status = "pending" | "open" | "considering" | "done" | "declined" | "removed";

const STATUS: Record<Exclude<Status, "removed">, { label: string; color: number }> = {
  pending: { label: "⏳ Waiting for an admin to post it", color: Colors.warn },
  open: { label: "🆕 New idea", color: Colors.info },
  considering: { label: "👀 Looking into it", color: Colors.warn },
  done: { label: "✅ Done", color: Colors.ok },
  declined: { label: "🚫 Not planned", color: Colors.muted },
};

interface Suggestion {
  id: number;
  userId: string;
  authorName: string;
  authorAvatar?: string;
  title: string;
  details: string;
  status: Status;
  note?: string;
  flagged: boolean;
  channelId?: string;
  messageId?: string;
  reviewChannelId?: string;
  reviewMessageId?: string;
  createdAt: number;
  updatedAt: number;
  decidedBy?: string;
}

interface Draft {
  title: string;
  details: string;
}

const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });

/** True when text contains profanity, slurs or sexual terms (including l33t-speak and s p a c i n g tricks the library knows). */
export function notFamilyFriendly(text: string): boolean {
  return matcher.hasMatch(text);
}

export const suggestions: ModuleFactory = ({ cfg, store, client, access }) => {
  const db = store.sql;
  db.exec(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS suggestions_user ON suggestions(user_id, created_at);
    CREATE TABLE IF NOT EXISTS suggestion_votes (
      suggestion_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (suggestion_id, user_id)
    );
  `);

  const drafts = new TtlCache<string, Draft>(30 * 60_000);
  const settings = () => ({ review: false, ...(store.kvGet<{ review: boolean }>(SETTINGS_KEY) ?? {}) });

  // ---- storage --------------------------------------------------------------------------
  const load = (id: number): Suggestion | undefined => {
    const row = db.prepare("SELECT id, data FROM suggestions WHERE id = ?").get(id) as { id: number; data: string } | undefined;
    return row ? { ...JSON.parse(row.data), id: row.id } : undefined;
  };
  const save = (s: Suggestion) => {
    s.updatedAt = Date.now();
    const { id, ...rest } = s;
    db.prepare("UPDATE suggestions SET status = ?, data = ? WHERE id = ?").run(s.status, JSON.stringify(rest), id);
  };
  const create = (s: Omit<Suggestion, "id">): Suggestion => {
    const r = db.prepare("INSERT INTO suggestions (user_id, status, data, created_at) VALUES (?, ?, ?, ?)").run(s.userId, s.status, JSON.stringify(s), s.createdAt);
    return { ...s, id: Number(r.lastInsertRowid) };
  };
  const votes = (id: number) => (db.prepare("SELECT COUNT(*) AS n FROM suggestion_votes WHERE suggestion_id = ?").get(id) as { n: number }).n;
  const recentBy = (userId: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE user_id = ? AND created_at > ?").get(userId, Date.now() - 86_400_000) as { n: number }).n;

  // ---- rendering --------------------------------------------------------------------------
  function postPayload(s: Suggestion) {
    const st = STATUS[s.status as Exclude<Status, "removed">] ?? STATUS.open;
    const e = new EmbedBuilder()
      .setColor(st.color)
      .setAuthor(s.authorAvatar ? { name: s.authorName || "A member", iconURL: s.authorAvatar } : { name: s.authorName || "A member" })
      .setTitle(truncate(`💡 ${s.title}`, 256))
      .addFields({ name: "Status", value: truncate(`${st.label}${s.note ? `\n> ${s.note}` : ""}`, 1024) })
      .setFooter({ text: `Suggestion #${s.id} · Got an idea? Use /suggest` })
      .setTimestamp(new Date(s.createdAt));
    if (s.details) e.setDescription(truncate(s.details, 2000));
    const n = votes(s.id);
    const closed = s.status === "done" || s.status === "declined";
    return {
      embeds: [e],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`sug:vote:${s.id}`)
            .setLabel(n ? String(n) : "Vote")
            .setEmoji("👍")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(closed),
          new ButtonBuilder().setCustomId(`sug:manage:${s.id}`).setLabel("Admins").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
        ),
      ],
      allowedMentions: { parse: [] as [] },
    };
  }

  function reviewPayload(s: Suggestion, outcome?: string) {
    const e = new EmbedBuilder()
      .setColor(outcome ? Colors.muted : Colors.warn)
      .setTitle(truncate(`💡 Suggestion to review: ${s.title}`, 256))
      .setDescription(
        `From <@${s.userId}>${s.details ? `\n\n${truncate(s.details, 2000)}` : ""}` +
          (s.flagged ? "\n\n⚠️ The family-friendly filter caught something in this. It can be cautious (e.g. *Moby Dick*), so check before posting." : "") +
          (outcome ? `\n\n**${outcome}**` : ""),
      )
      .setFooter({ text: `Suggestion #${s.id}` });
    return {
      embeds: [e],
      components: outcome
        ? []
        : [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`sug:approve:${s.id}`).setLabel("Post it").setEmoji("✅").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`sug:reject:${s.id}`).setLabel("Don't post").setStyle(ButtonStyle.Secondary),
            ),
          ],
      allowedMentions: { parse: [] as [] },
    };
  }

  function form(draft?: Draft) {
    return new ModalBuilder()
      .setCustomId("sug:new")
      .setTitle("Share an idea")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("title")
            .setLabel("Your idea")
            .setPlaceholder("e.g. A kids' movies section (for a movie or show, use /request)")
            .setStyle(TextInputStyle.Short)
            .setMinLength(5)
            .setMaxLength(100)
            .setRequired(true)
            .setValue(draft?.title ?? ""),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("details")
            .setLabel("Tell us more (optional)")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1000)
            .setRequired(false)
            .setValue(draft?.details ?? ""),
        ),
      );
  }

  const channelLink = (channelId: string, messageId: string) => `https://discord.com/channels/${cfg.guildId}/${channelId}/${messageId}`;

  async function sendTo(c: Client, channelId: string | undefined, payload: ReturnType<typeof postPayload> | ReturnType<typeof reviewPayload>) {
    if (!channelId) return null;
    const ch = await c.channels.fetch(channelId).catch(() => null);
    if (!ch?.isSendable()) return null;
    return (ch as SendableChannels).send(payload).catch((err) => {
      log.warn(`suggestions: couldn't post in ${channelId}: ${(err as Error).message}`);
      return null;
    });
  }

  async function editMessage(channelId: string | undefined, messageId: string | undefined, payload: object) {
    if (!channelId || !messageId) return false;
    try {
      const ch = await client.channels.fetch(channelId);
      if (!ch || !("messages" in ch)) return false;
      const msg = await ch.messages.fetch(messageId);
      await msg.edit(payload);
      return true;
    } catch {
      return false;
    }
  }

  /** Posts a suggestion publicly. Returns the link, or undefined if it couldn't. */
  async function publish(s: Suggestion): Promise<string | undefined> {
    s.status = "open";
    save(s);
    const msg = await sendTo(client, cfg.channels.suggestions, postPayload(s));
    if (!msg) {
      s.status = "pending";
      save(s);
      return undefined;
    }
    s.channelId = msg.channelId;
    s.messageId = msg.id;
    save(s);
    return channelLink(msg.channelId, msg.id);
  }

  /** Sends a suggestion to the admins to look at before it's posted. */
  async function toReview(s: Suggestion): Promise<boolean> {
    const msg = await sendTo(client, cfg.channels.admin, reviewPayload(s));
    if (!msg) return false;
    s.reviewChannelId = msg.channelId;
    s.reviewMessageId = msg.id;
    save(s);
    return true;
  }

  const authorFor = (i: ModalSubmitInteraction | MessageComponentInteraction) => {
    const member = i.member && "displayName" in i.member ? i.member : undefined;
    const name = member?.displayName ?? i.user.globalName ?? i.user.username ?? "A member";
    return {
      authorName: notFamilyFriendly(name) ? "A member" : name,
      authorAvatar: typeof i.user.displayAvatarURL === "function" ? i.user.displayAvatarURL() : undefined,
    };
  };

  /** The member's text, posted or sent for review. */
  async function submit(i: ModalSubmitInteraction | MessageComponentInteraction, draft: Draft, privately: boolean) {
    const admin = access.isAdmin(i);
    const flagged = notFamilyFriendly(`${draft.title}\n${draft.details}`);
    const review = privately || (settings().review && !admin);
    const s = create({
      userId: i.user.id,
      ...authorFor(i),
      title: draft.title,
      details: draft.details,
      status: "pending",
      flagged,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    drafts.delete(i.user.id);
    log.info(`suggestions: #${s.id} from ${i.user.id}${flagged ? " (flagged)" : ""}${review ? " → review" : ""}: ${truncate(draft.title, 80)}`);

    if (review) {
      if (!(await toReview(s))) {
        s.status = "removed";
        save(s);
        drafts.set(i.user.id, draft);
        return "⚠️ I couldn't reach the admins right now. Please try again in a bit (your text is saved; just run `/suggest`).";
      }
      return privately
        ? "📨 Sent to the admins privately. If it's all fine, they'll post it, and I'll DM you either way."
        : "📨 Thanks! An admin will take a quick look before it's posted. I'll DM you when it's up.";
    }
    const link = await publish(s);
    if (!link) {
      // Couldn't post publicly (missing channel or permissions): don't lose it.
      if (await toReview(s)) return "📨 Thanks! I couldn't post it publicly just now, so I've passed it to the admins instead.";
      drafts.set(i.user.id, draft);
      return "⚠️ I couldn't post that right now. An admin needs to check my permissions. Your text is saved; run `/suggest` to try again.";
    }
    return `✅ Thanks! It's up: ${link}\nPeople can 👍 it, and I'll DM you when an admin responds.`;
  }

  async function notifyAuthor(s: Suggestion) {
    const what = `your suggestion **${truncate(s.title, 80)}**`;
    const text: Partial<Record<Status, string>> = {
      considering: `👀 An admin is looking into ${what}.`,
      done: `✅ Good news: ${what} is done!`,
      declined: `🚫 ${what[0].toUpperCase()}${what.slice(1)} won't happen for now.`,
      open: `💡 ${what[0].toUpperCase()}${what.slice(1)} is up for people to 👍.`,
    };
    const line = text[s.status];
    if (!line) return;
    const link = s.channelId && s.messageId ? `\n${channelLink(s.channelId, s.messageId)}` : "";
    await dm(client, s.userId, `${line}${s.note ? `\n> ${s.note}` : ""}${link}`);
  }

  async function setStatus(s: Suggestion, status: Status, by: string, note?: string) {
    s.status = status;
    s.note = note?.trim() || undefined;
    s.decidedBy = by;
    save(s);
    log.info(`suggestions: #${s.id} → ${status} by ${by}`);
    await editMessage(s.channelId, s.messageId, postPayload(s));
    await notifyAuthor(s);
  }

  // ---- handlers -----------------------------------------------------------------------------
  async function onModal(i: ModalSubmitInteraction) {
    const [, kind, idStr, status] = i.customId.split(":");
    if (kind === "new") {
      const draft = { title: i.fields.getTextInputValue("title").trim(), details: i.fields.getTextInputValue("details").trim() };
      if (draft.title.length < 5) return void (await i.reply({ content: "Please give your idea a few more words.", flags: MessageFlags.Ephemeral }));
      if (notFamilyFriendly(`${draft.title}\n${draft.details}`) && !access.isAdmin(i)) {
        drafts.set(i.user.id, draft);
        return void (await i.reply({
          content:
            "🙂 Let's keep it family-friendly: something in there looks like a swear word or similar, so I didn't post it.\n" +
            "-# If it's a false alarm (like a title such as *Moby Dick*), send it to the admins and they can post it.",
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId("sug:edit").setLabel("Reword it").setEmoji("✏️").setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId("sug:private").setLabel("Send to admins").setStyle(ButtonStyle.Secondary),
            ),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await i.editReply(await submit(i, draft, false));
      return;
    }
    if (kind === "note") {
      if (!access.isAdmin(i)) return void (await i.reply({ content: "🔒 Only admins can do that.", flags: MessageFlags.Ephemeral }));
      const s = load(Number(idStr));
      if (!s) return void (await i.reply({ content: "That suggestion is gone.", flags: MessageFlags.Ephemeral }));
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await setStatus(s, status as Status, i.user.id, i.fields.getTextInputValue("note"));
      await i.editReply(`Updated #${s.id}: ${STATUS[s.status as Exclude<Status, "removed">].label}. ${s.userId === i.user.id ? "" : "They've been told."}`);
    }
  }

  async function onComponent(i: MessageComponentInteraction) {
    const [, action, idStr] = i.customId.split(":");

    // From the "let's keep it family-friendly" reply.
    if (action === "edit" || action === "private") {
      const draft = drafts.get(i.user.id);
      if (!draft) return void (await i.update({ content: "⌛ That expired. Run `/suggest` again.", components: [] }));
      if (action === "edit") return void (await i.showModal(form(draft)));
      await i.deferUpdate();
      await i.editReply({ content: await submit(i, draft, true), components: [] });
      return;
    }

    const s = load(Number(idStr));
    if (!s || s.status === "removed") return void (await i.reply({ content: "That suggestion is gone.", flags: MessageFlags.Ephemeral }));

    if (action === "vote") {
      if (s.status === "done" || s.status === "declined") return void (await i.reply({ content: "Voting's closed on this one.", flags: MessageFlags.Ephemeral }));
      const had = db.prepare("DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?").run(s.id, i.user.id).changes > 0;
      if (!had) db.prepare("INSERT OR IGNORE INTO suggestion_votes (suggestion_id, user_id) VALUES (?, ?)").run(s.id, i.user.id);
      await i.update(postPayload(s));
      await i.followUp({
        content: had ? "Your 👍 is taken back." : "👍 Thanks for voting! Tap it again if you change your mind.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!access.isAdmin(i)) return void (await i.reply({ content: "🔒 That's for admins. Tap 👍 to vote for it!", flags: MessageFlags.Ephemeral }));

    if (action === "manage") {
      return void (await i.reply({
        content: `Suggestion #${s.id}: what's the status?`,
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`sug:status:${s.id}`)
              .setPlaceholder("Choose a status")
              .addOptions(
                { label: "Looking into it", value: "considering", emoji: "👀" },
                { label: "Done", value: "done", emoji: "✅" },
                { label: "Not planned", value: "declined", emoji: "🚫" },
                { label: "Back to new", value: "open", emoji: "🆕" },
                { label: "Remove it (spam or not OK)", value: "removed", emoji: "🗑️" },
              ),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      }));
    }

    if (action === "status" && i.isStringSelectMenu()) {
      const status = i.values[0] as Status;
      if (status === "removed") {
        s.status = "removed";
        s.decidedBy = i.user.id;
        save(s);
        if (s.channelId && s.messageId) {
          const ch = await client.channels.fetch(s.channelId).catch(() => null);
          if (ch && "messages" in ch) await ch.messages.delete(s.messageId).catch(() => undefined);
        }
        log.info(`suggestions: #${s.id} removed by ${i.user.id}`);
        return void (await i.update({ content: `🗑️ Removed suggestion #${s.id}. They weren't notified.`, components: [] }));
      }
      return void (await i.showModal(
        new ModalBuilder()
          .setCustomId(`sug:note:${s.id}:${status}`)
          .setTitle(`${STATUS[status as Exclude<Status, "removed">].label.slice(0, 40)}`)
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("note")
                .setLabel("A note for everyone (optional)")
                .setPlaceholder("e.g. Added! Check the Kids library.")
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(300)
                .setRequired(false)
                .setValue(s.note ?? ""),
            ),
          ),
      ));
    }

    if (action === "approve" || action === "reject") {
      if (s.status !== "pending") return void (await i.reply({ content: "Someone already dealt with that one.", flags: MessageFlags.Ephemeral }));
      await i.deferUpdate();
      if (action === "reject") {
        s.status = "removed";
        s.decidedBy = i.user.id;
        save(s);
        await dm(client, s.userId, `Thanks for your suggestion **${truncate(s.title, 80)}**. The admins decided not to post it, but they've seen it.`);
        await i.editReply(reviewPayload(s, `Not posted (by ${i.user.username})`));
        return;
      }
      s.decidedBy = i.user.id;
      const link = await publish(s);
      if (!link) {
        await i.followUp({ content: "⚠️ I couldn't post in the suggestions channel. Set it with `/setup channels suggestions:#…` and check my permissions there.", flags: MessageFlags.Ephemeral });
        return;
      }
      await notifyAuthor(s);
      await i.editReply(reviewPayload(s, `Posted by ${i.user.username}: ${link}`));
    }
  }

  return {
    name: "suggestions",
    commands: [
      {
        name: "suggest",
        description: "Share an idea for the server. Others can 👍 it",
        execute: async (i) => {
          const admin = access.isAdmin(i);
          if (!cfg.channels.suggestions && !(settings().review && cfg.channels.admin)) {
            return void (await i.reply({
              content: admin
                ? "Pick a channel for suggestions first: `/setup channels suggestions:#channel` (make it read-only for members)."
                : "Suggestions aren't set up yet. An admin needs to pick a channel for them first.",
              flags: MessageFlags.Ephemeral,
            }));
          }
          if (!admin && recentBy(i.user.id) >= DAILY_LIMIT) {
            return void (await i.reply({
              content: `You've shared ${DAILY_LIMIT} ideas in the last 24 hours. Thanks! Give it a day, and 👍 the ones you like in the meantime.`,
              flags: MessageFlags.Ephemeral,
            }));
          }
          await i.showModal(form(drafts.get(i.user.id)));
        },
      },
    ],
    subcommands: [
      {
        ...ADMIN,
        group: { name: "suggestions", description: "Members' ideas from /suggest" },
        name: "review",
        description: "Look at every suggestion before it's posted",
        build: (b) =>
          b.addStringOption((o) =>
            o
              .setName("mode")
              .setDescription("On: admins approve each one first. Off: posted straight away (after the family-friendly check)")
              .setRequired(true)
              .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" }),
          ),
        execute: async (i) => {
          const on = i.options.getString("mode", true) === "on";
          if (on && !cfg.channels.admin) {
            return void (await i.reply({ content: "Set an admin channel first (`/setup channels admin:#channel`): that's where suggestions wait for review.", flags: MessageFlags.Ephemeral }));
          }
          store.kvSet(SETTINGS_KEY, { ...settings(), review: on });
          log.info(`suggestions: review ${on ? "on" : "off"} (${i.user.id})`);
          await i.reply({
            content: on
              ? `⏳ Review is **on**. New suggestions wait in <#${cfg.channels.admin}> for a **Post it** click.`
              : "▶️ Review is **off**. Suggestions are posted straight away after the family-friendly check.",
            flags: MessageFlags.Ephemeral,
          });
        },
      },
      {
        ...ADMIN,
        group: { name: "suggestions", description: "Members' ideas from /suggest" },
        name: "top",
        description: "Open suggestions with the most 👍",
        execute: async (i) => {
          const rows = db
            .prepare(
              `SELECT s.id, COUNT(v.user_id) AS n FROM suggestions s LEFT JOIN suggestion_votes v ON v.suggestion_id = s.id
               WHERE s.status IN ('open', 'considering', 'pending') GROUP BY s.id ORDER BY n DESC, s.created_at DESC LIMIT 15`,
            )
            .all() as Array<{ id: number; n: number }>;
          const lines = rows
            .map((r) => ({ s: load(r.id)!, n: r.n }))
            .map(({ s, n }) => {
              const where = s.channelId && s.messageId ? ` · [open](${channelLink(s.channelId, s.messageId)})` : s.status === "pending" ? " · waiting for review" : "";
              return `**👍 ${n}** · #${s.id} ${truncate(s.title, 70)} · <@${s.userId}>${s.status === "considering" ? " · 👀" : ""}${where}`;
            });
          await i.reply({
            embeds: [new EmbedBuilder().setColor(Colors.info).setTitle("💡 Top suggestions").setDescription(truncate(lines.join("\n") || "No open suggestions.", 4000))],
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        },
      },
    ],
    components: { sug: onComponent },
    modals: { sug: onModal },
  };
};
