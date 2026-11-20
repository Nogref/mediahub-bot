/**
 * The member's progress tracker: a plain-language card that updates itself as
 * a redownload moves along. It lives in their DMs (edited in place) and, for
 * the first few minutes, in the reply where they started it. No app names,
 * no jargon: just "finding a copy → downloading → swapping → ready".
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type MessageComponentInteraction } from "discord.js";
import { Colors, truncate } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { Job, RedownloadStore } from "./store.js";
import type { Release } from "./types.js";

/** "Bluray-1080p" → "1080p", "WEBDL-2160p" → "4K"; music formats stay as they are. */
export function friendlyQuality(q: string): string {
  const m = q.match(/(2160|1080|720|576|480)p/i);
  if (!m) return q.replace(/-/g, " ");
  return m[1] === "2160" ? "4K" : `${m[1]}p`;
}

export function friendlySize(bytes: number): string {
  if (!bytes) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** How quickly it's likely to download, without saying "seeders". */
export function speedLabel(r: Release): string {
  if (r.protocol !== "torrent" || r.seeders === undefined) return "fast download";
  if (r.seeders >= 20) return "fast download";
  if (r.seeders >= 5) return "normal speed";
  return "may be slow";
}

export function friendlyRelease(r: Release): string {
  return [friendlyQuality(r.quality), friendlySize(r.size), speedLabel(r)].filter(Boolean).join(" · ");
}

function bar(pct: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${pct}%`;
}

const t = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

/** One line per step: ✅ done, ▶️ happening now, ⬜ still to come. */
function steps(j: Job): string[] {
  const kind = j.target.kind === "album" ? "album" : j.target.kind === "season" ? "season" : j.target.kind;
  const found = j.current ? `Found a fresh copy · ${friendlyQuality(j.current.quality)}${j.current.size ? ` · ${friendlySize(j.current.size)}` : ""}` : "Find a fresh copy";
  const order = ["received", "find", "download", "swap", "ready"] as const;
  const at: Record<string, number> = {
    awaiting_approval: 0,
    grabbing: 1,
    downloading: 2,
    swapping: 3,
    importing: 3,
    needs_admin: 3,
    done: 5,
  };
  const pos = at[j.state] ?? 0;

  let downloading = "Download it";
  if (j.state === "downloading") {
    if (j.binWarned) downloading = "Downloaded. ⏸️ On hold while an admin checks a setting (it carries on by itself)";
    else if (j.queueStatus && /queued|delay|paused/i.test(j.queueStatus) && !j.progress) downloading = "Waiting in line to start downloading";
    else if (j.progress === undefined) downloading = "Starting the download…";
    else {
      const eta = j.eta && Date.parse(j.eta) > Date.now() ? ` · done ${t(Date.parse(j.eta))}` : "";
      downloading = `Downloading  ${bar(j.progress)}${eta}`;
      if (j.queueStatus && /warning|stalled/i.test(j.queueStatus)) downloading += "\n    *Going slowly right now, still trying*";
    }
  } else if (pos > 2) downloading = "Downloaded";

  const swap =
    j.state === "needs_admin"
      ? "Swapping it in: an admin is finishing this part by hand. Nothing you need to do"
      : pos === 3
        ? "Swapping in the new copy (a minute or two)"
        : pos > 3
          ? "Swapped in"
          : "Swap it in";

  const text = {
    received: j.state === "awaiting_approval" ? "Request received · ⏳ waiting for an admin to OK it" : "Request received",
    find: j.state === "grabbing" ? (j.attempt > 0 ? "Finding another copy…" : "Finding a fresh copy…") : found,
    download: downloading,
    swap,
    ready: j.state === "done" ? `Ready to watch${kind === "album" ? " (ready to play)" : ""}` : "Ready to watch",
  };
  return order.map((k, idx) => `${idx < pos ? "✅" : idx === pos ? "▶️" : "⬜"} ${text[k]}`);
}

const ENDED: Record<string, { title: string; color: number; body: (j: Job) => string }> = {
  done: {
    title: "✅ Ready to watch",
    color: Colors.ok,
    body: (j) =>
      /^Marked resolved/.test(j.outcome ?? "")
        ? "An admin finished this one up. If it's still not right, use `/report`."
        : `**${j.target.label}** has been replaced with a fresh copy. If Plex still plays the old one, back out and open it again (Plex can take a few minutes to notice).`,
  },
  failed: {
    title: "😕 Couldn't fix this one",
    color: Colors.bad,
    body: (j) =>
      `${j.attempt > 0 ? `I tried ${j.attempt} different cop${j.attempt === 1 ? "y" : "ies"} and none of them worked out.` : "I couldn't find another copy to use right now."} ` +
      "**Your original is untouched** and this didn't count toward your daily redownloads. If it's still broken, use `/report` so an admin can take a look.",
  },
  cancelled: {
    title: "🛑 Cancelled",
    color: Colors.muted,
    body: () => "Stopped before anything was changed. Your original is untouched and this didn't count toward your daily redownloads.",
  },
  denied: {
    title: "🚫 Not approved",
    color: Colors.muted,
    body: (j) => `An admin didn't approve this one${j.outcome ? ` (${truncate(j.outcome, 200)})` : ""}. It didn't count toward your daily redownloads.`,
  },
};

export function trackerEmbed(j: Job): EmbedBuilder {
  const e = new EmbedBuilder().setFooter({ text: `Redownload #${j.id} · /redownload status shows this anytime` });
  if (j.target.posterUrl) e.setThumbnail(j.target.posterUrl);
  const ended = ENDED[j.state];
  if (ended) {
    return e
      .setColor(ended.color)
      .setTitle(truncate(`${ended.title}: ${j.target.label}`, 256))
      .setDescription(ended.body(j));
  }
  const notes: string[] = [];
  if (j.attempt > 1 && (j.state === "grabbing" || j.state === "downloading")) {
    notes.push(`🔄 The first cop${j.attempt === 2 ? "y" : "ies"} didn't work out, so I'm trying another (try ${j.attempt}).`);
  }
  if (j.state === "swapping" || j.state === "importing" || j.state === "needs_admin") {
    notes.push("It may disappear from Plex for a minute while the new copy goes in.");
  } else {
    notes.push("Your current copy keeps working until the new one is ready.");
  }
  return e
    .setColor(j.state === "needs_admin" ? Colors.warn : Colors.info)
    .setTitle(truncate(`🔁 Fixing ${j.target.label}`, 256))
    .setDescription(`${steps(j).join("\n")}\n\n${notes.join("\n")}\n-# Started ${t(j.createdAt)} · updated ${t(j.updatedAt)}`);
}

export function trackerButtons(j: Job): ActionRowBuilder<ButtonBuilder>[] {
  if (ENDED[j.state]) return [];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rdt:refresh:${j.id}`).setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
  );
  if (j.state === "awaiting_approval" || j.state === "grabbing" || j.state === "downloading") {
    row.addComponents(new ButtonBuilder().setCustomId(`rdt:cancel:${j.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary));
  }
  return [row];
}

export function trackerPayload(j: Job) {
  return { content: "", embeds: [trackerEmbed(j)], components: trackerButtons(j) };
}

/** What the card would show, minus the "updated" time: only edit when this changes. */
function signature(j: Job): string {
  const pct = j.progress === undefined ? "" : Math.floor(j.progress / 5);
  const eta = j.eta ? Math.floor(Date.parse(j.eta) / 300_000) : "";
  return [j.state, j.attempt, j.current?.title, pct, eta, j.queueStatus, j.binWarned].join("|");
}

interface Editable {
  editReply(p: unknown): Promise<unknown>;
}

const REPLY_EDIT_WINDOW_MS = 14 * 60_000; // Discord allows edits to an interaction reply for 15 minutes

export class Tracker {
  private replies = new Map<number, { i: Editable; at: number; header: string }>();
  private last = new Map<number, string>();

  constructor(
    private readonly client: Client,
    private readonly rstore: RedownloadStore,
  ) {}

  /** Keep the reply where they started it up to date too (for the first few minutes). */
  attachReply(jobId: number, i: Editable, header = "") {
    this.replies.set(jobId, { i, at: Date.now(), header });
  }

  /** Sends the tracker to their DMs. False when their DMs are closed. */
  async start(job: Job): Promise<boolean> {
    try {
      const user = await this.client.users.fetch(job.discordUserId);
      const msg = await user.send(trackerPayload(job));
      job.trackerChannelId = msg.channelId;
      job.trackerMessageId = msg.id;
      this.remember(job.id, msg.channelId, msg.id);
      this.last.set(job.id, signature(job));
      return true;
    } catch (err) {
      log.info(`redownload #${job.id}: couldn't DM the tracker to ${job.discordUserId}: ${(err as Error).message}`);
      return false;
    }
  }

  async update(job: Job, force = false): Promise<void> {
    const sig = signature(job);
    if (!force && this.last.get(job.id) === sig) return;
    this.last.set(job.id, sig);
    const payload = trackerPayload(job);

    const reply = this.replies.get(job.id);
    if (reply) {
      if (Date.now() - reply.at > REPLY_EDIT_WINDOW_MS) this.replies.delete(job.id);
      else await reply.i.editReply({ ...payload, content: ENDED[job.state] ? "" : reply.header }).catch(() => this.replies.delete(job.id));
    }
    if (!job.trackerChannelId || !job.trackerMessageId) return;
    try {
      const ch = await this.client.channels.fetch(job.trackerChannelId);
      if (!ch || !("messages" in ch)) return;
      const msg = await ch.messages.fetch(job.trackerMessageId);
      await msg.edit(payload);
    } catch (err) {
      // They deleted the message or closed their DMs: stop trying; /redownload status still works.
      log.debug(`redownload #${job.id}: tracker edit failed: ${(err as Error).message}`);
      job.trackerChannelId = undefined;
      job.trackerMessageId = undefined;
      this.remember(job.id, undefined, undefined);
    }
    if (ENDED[job.state]) {
      this.replies.delete(job.id);
      this.last.delete(job.id);
    }
  }

  /** Shows the card on a button press (Refresh / Cancel). */
  async show(i: MessageComponentInteraction, job: Job, content = ""): Promise<void> {
    this.last.set(job.id, signature(job));
    await i.editReply({ ...trackerPayload(job), content });
  }

  /**
   * Saves just the tracker location onto the stored job. Load and save happen
   * with no await in between, so this never overwrites the engine's progress.
   */
  private remember(id: number, channelId?: string, messageId?: string) {
    const fresh = this.rstore.job(id);
    if (!fresh) return;
    fresh.trackerChannelId = channelId;
    fresh.trackerMessageId = messageId;
    this.rstore.saveJob(fresh);
  }
}
