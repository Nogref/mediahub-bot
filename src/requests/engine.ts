/**
 * Keeps each member's request tracker up to date: checks where the request
 * is, edits their DM card, and sends one short DM when it's ready (or can't be
 * found for a day, or was declined). Replaces "@ you in announcements".
 */
import type { Client, SendableChannels } from "discord.js";
import type { Config } from "../config.js";
import type { Store, TrackedRequest } from "../core/db.js";
import { dm } from "../core/discord.js";
import { log } from "../core/logger.js";
import { snapshot, type ProgressDeps, type Snapshot } from "./progress.js";
import { requestLabel, signature, trackerPayload } from "./render.js";
import { RQ_FINAL, type RequestTrackerStore, type RqTracker } from "./store.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How often each state is re-checked. */
const EVERY: Record<string, number> = {
  approval: 5 * MIN,
  searching: 3 * MIN,
  downloading: 1 * MIN,
  stalled: 10 * MIN,
  not_out: 6 * HOUR,
};
export const STALL_AFTER = DAY;
const DEFAULT_INTRO = "📬 Got your request! I'll keep this updated, and message you when it's ready.";

export interface RequestEngineDeps {
  store: Store;
  tstore: RequestTrackerStore;
  progress: ProgressDeps;
  client: Client;
  cfg: Config;
  /** Where to @ the member when their DMs are closed (only while announcements are on). */
  fallbackChannel?: () => string | undefined;
}

interface Editable {
  editReply(p: unknown): Promise<unknown>;
}

export class RequestEngine {
  private timer?: NodeJS.Timeout;
  private readonly busy = new Set<number>();
  private readonly shown = new Map<number, string>();
  private readonly replies = new Map<number, { i: Editable; at: number; header: string }>();

  constructor(private readonly d: RequestEngineDeps) {}

  start(intervalMs = 30 * SEC) {
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tickAll() {
    const now = Date.now();
    for (const t of this.d.tstore.active()) {
      if ((t.nextCheckAt ?? 0) <= now) await this.tick(t.requestId);
    }
  }

  /** Something just arrived (a webhook): check these right away. */
  async nudge(requestIds: number[]) {
    for (const id of requestIds) if (this.d.tstore.get(id)) await this.tick(id);
  }

  /**
   * Starts tracking a request and DMs the card. If it turns out to be on Plex
   * already, nothing is DMed. `intro` is the line above the card in the DM.
   */
  async track(requestId: number, opts: { intro?: string; reply?: Editable; note?: string } = {}): Promise<RqTracker | undefined> {
    const r = this.d.store.requestById(requestId);
    if (!r) return undefined;
    const note = opts.note ? `\n${opts.note}` : "";
    const existing = this.d.tstore.get(requestId);
    if (existing && !RQ_FINAL.includes(existing.state)) {
      // Asked again for something already tracked: show the same card.
      if (opts.reply) {
        this.replies.set(requestId, { i: opts.reply, at: Date.now(), header: `You've already asked for this. Here's where it's at:${note}` });
        await this.update(r, existing, true);
      }
      return existing;
    }
    const now = Date.now();
    const t: RqTracker = { requestId, state: "searching", startedAt: now, updatedAt: now, lastActivityAt: now, intro: opts.intro ?? DEFAULT_INTRO };
    let snap: Snapshot | undefined;
    try {
      snap = await snapshot(this.d.progress, r, t);
    } catch (err) {
      log.debug(`requests: first check of ${r.id} (${r.title}) failed: ${(err as Error).message}`);
    }
    if (snap) this.apply(t, snap);

    if (t.state === "done") {
      // Already there: no DM, no tracking.
      t.finishedAt = now;
      this.d.tstore.save(t);
      this.d.store.markNotified([r.id]);
      await opts.reply?.editReply(trackerPayload(r, t)).catch(() => undefined);
      return t;
    }
    t.nextCheckAt = now + (EVERY[t.state] ?? 3 * MIN);
    this.d.tstore.save(t);
    let dmOk = false;
    try {
      const user = await this.d.client.users.fetch(r.discordUserId);
      const m = await user.send(trackerPayload(r, t));
      t.dmChannelId = m.channelId;
      t.dmMessageId = m.id;
      this.d.tstore.save(t);
      this.shown.set(r.id, signature(t));
      dmOk = true;
    } catch (err) {
      log.info(`requests: couldn't DM ${r.discordUserId} a tracker for ${r.title}: ${(err as Error).message}`);
    }
    if (opts.reply) {
      const header = dmOk
        ? `✅ Requested! I've sent you a DM that keeps you posted until it's ready.${note}`
        : `✅ Requested! Your DMs are closed, so this message keeps you posted for the next few minutes. \`/requests\` shows it anytime.${note}`;
      this.replies.set(requestId, { i: opts.reply, at: now, header });
      await opts.reply.editReply({ ...trackerPayload(r, t), content: header }).catch(() => this.replies.delete(requestId));
    }
    if (t.state === "declined") await this.finish(r, t);
    return t;
  }

  /** The Refresh button, and the per-request check. */
  async tick(requestId: number, force = false): Promise<RqTracker | undefined> {
    if (this.busy.has(requestId)) return this.d.tstore.get(requestId);
    this.busy.add(requestId);
    try {
      const r = this.d.store.requestById(requestId);
      const t = this.d.tstore.get(requestId);
      if (!r || !t) return t;
      if (RQ_FINAL.includes(t.state)) {
        if (force) await this.update(r, t, true);
        return t;
      }
      let checked = true;
      try {
        this.apply(t, await snapshot(this.d.progress, r, t));
        t.errorCount = 0;
      } catch (err) {
        checked = false;
        t.errorCount = (t.errorCount ?? 0) + 1;
        if (t.errorCount === 1 || t.errorCount % 20 === 0) log.warn(`requests: couldn't check ${r.title} (#${r.id}): ${(err as Error).message}`);
      }
      const now = Date.now();

      // 24 hours with nothing happening, for something that's out: tell them and the admins (once).
      // Not while the apps can't be reached: that says nothing about the request.
      if (checked && (t.state === "searching" || t.state === "downloading") && !t.stalledAt && now - t.lastActivityAt >= STALL_AFTER) {
        t.stalledAt = now;
        if (t.state === "searching") t.state = "stalled";
        await this.stalled(r, t);
      }
      // Give up after REQUEST_TRACK_DAYS, counted from release day for things that weren't out yet
      // (and after a year for things that still have no release date).
      const from = Math.max(r.createdAt, t.outAt ?? 0, t.releaseAt && t.releaseAt < now ? t.releaseAt : 0);
      const limit = t.state === "not_out" ? 365 * DAY : this.d.cfg.notify.trackDays * DAY;
      if (checked && !RQ_FINAL.includes(t.state) && now - (t.state === "not_out" ? r.createdAt : from) > limit) t.state = "expired";

      // Back off while the apps are unreachable (up to 30 minutes).
      if (!checked) t.nextCheckAt = now + Math.min(30 * MIN, (EVERY[t.state] ?? 3 * MIN) * 2 ** Math.min(t.errorCount ?? 1, 5));
      else t.nextCheckAt = now + Math.min(EVERY[t.state] ?? 3 * MIN, t.state === "not_out" && t.releaseAt && t.releaseAt > now ? Math.max(MIN, t.releaseAt - now + MIN) : Infinity);
      if (RQ_FINAL.includes(t.state)) t.finishedAt = now;
      this.d.tstore.save(t);
      await this.update(r, t, force);
      if (RQ_FINAL.includes(t.state)) await this.finish(r, t);
      return t;
    } finally {
      this.busy.delete(requestId);
    }
  }

  attachReply(requestId: number, i: Editable, header: string) {
    this.replies.set(requestId, { i, at: Date.now(), header });
  }

  /** Copies a fresh snapshot onto the tracker and notes whether anything moved. */
  private apply(t: RqTracker, s: Snapshot) {
    const prev = t.state === "stalled" ? "searching" : t.state;
    const moved =
      s.state !== prev || s.onPlex > (t.onPlex ?? 0) || (s.progress ?? -1) > (t.progress ?? -1) || (s.tracks?.have ?? 0) > (t.tracks?.have ?? 0);
    const now = Date.now();
    // Waiting for approval or a release date isn't "stuck": the 24h clock starts once it's out.
    if (moved || s.state === "approval" || s.state === "not_out") t.lastActivityAt = now;
    if (moved) t.stalledAt = undefined;
    if (t.state === "not_out" && s.state !== "not_out") t.outAt = now;
    t.state = t.stalledAt && s.state === "searching" ? "stalled" : s.state;
    t.progress = s.progress;
    t.eta = s.eta;
    t.queueStatus = s.queueStatus;
    t.releaseAt = s.releaseAt ?? t.releaseAt;
    t.seasons = s.seasons;
    t.tracks = s.tracks;
    t.onPlex = s.onPlex;
    if (s.requestedSeasons?.length) t.requestedSeasons = s.requestedSeasons;
  }

  private async update(r: TrackedRequest, t: RqTracker, force = false) {
    const sig = signature(t);
    if (!force && this.shown.get(r.id) === sig) return;
    this.shown.set(r.id, sig);
    const payload = trackerPayload(r, t);
    const ended = RQ_FINAL.includes(t.state);
    const reply = this.replies.get(r.id);
    if (reply) {
      if (Date.now() - reply.at > 14 * MIN) this.replies.delete(r.id);
      else await reply.i.editReply({ ...payload, content: ended ? "" : reply.header }).catch(() => this.replies.delete(r.id));
    }
    if (t.dmChannelId && t.dmMessageId) {
      try {
        const ch = await this.d.client.channels.fetch(t.dmChannelId);
        if (ch && "messages" in ch) await (await ch.messages.fetch(t.dmMessageId)).edit({ ...payload, content: ended ? "" : (t.intro ?? "") });
      } catch {
        t.dmMessageId = undefined; // deleted: /requests still shows it
        this.d.tstore.save(t);
      }
    }
    if (ended) {
      this.replies.delete(r.id);
      this.shown.delete(r.id);
    }
  }

  private logChannel() {
    return this.d.cfg.channels.redownloadLog ?? this.d.cfg.channels.admin;
  }

  private async postLog(text: string) {
    const id = this.logChannel();
    if (!id) return;
    const ch = await this.d.client.channels.fetch(id).catch(() => null);
    if (ch?.isSendable()) await (ch as SendableChannels).send({ content: text.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => undefined);
  }

  private app(r: TrackedRequest) {
    return r.kind === "movie" ? "Radarr" : r.kind === "tv" ? "Sonarr" : r.target === "aurral" ? "Aurral" : "Lidarr";
  }

  private async stalled(r: TrackedRequest, t: RqTracker) {
    const label = requestLabel(r);
    const tv = r.kind === "tv" && t.seasons?.length ? ` (${t.seasons.filter((s) => s.aired > s.onPlex).map((s) => `S${s.season}: ${s.aired - s.onPlex} missing`).join(", ")})` : "";
    if (t.state === "downloading") {
      await this.say(r, `⚠️ The download of **${label}** has been stuck for a day. I've let the admins know, and I'll keep watching.`);
      await this.postLog(
        `⚠️ <@${r.discordUserId}>'s request for **${label}** has been stuck at ${t.progress ?? 0}% for 24 hours. Check ${this.app(r)} → Activity and the download client.`,
      );
      return;
    }
    const some = r.kind === "tv" && (t.onPlex ?? 0) > 0;
    await this.say(
      r,
      some
        ? `😕 I still can't find the rest of **${label}**: there's no copy of the missing episodes out there yet. I've let the admins know, and I'll keep watching.`
        : `😕 Still no luck with **${label}**: there's no copy out there yet. I've let the admins know, and I'll keep watching. You'll hear from me when it's ready.`,
    );
    await this.postLog(
      `🔎 <@${r.discordUserId}> asked for **${label}**${tv} ${Math.round((Date.now() - r.createdAt) / DAY) || 1} day(s) ago and nothing has downloaded in the last 24 hours. Check ${this.app(r)} → Wanted / Activity, or grab it manually.`,
    );
  }

  private async finish(r: TrackedRequest, t: RqTracker) {
    const label = `**${requestLabel(r)}**`;
    if (t.state === "done") {
      this.d.store.markNotified([r.id]);
      const later = r.kind === "tv" ? (t.seasons ?? []).reduce((a, s) => a + s.upcoming, 0) : 0;
      const more = later ? ` ${later} more episode${later === 1 ? " is" : "s are"} still to air; they'll show up on Plex as they come out.` : "";
      const where = r.kind === "album" ? "in the music library" : "on Plex";
      await this.say(r, `✅ ${label} is ${where} now. Enjoy!${more}`, true);
    } else if (t.state === "declined") {
      this.d.store.endRequest(r.id);
      await this.say(r, `🚫 Your request for ${label} wasn't approved.`);
    } else if (t.state === "expired") {
      this.d.store.endRequest(r.id);
      const some = r.kind === "tv" && (t.onPlex ?? 0) > 0;
      await this.say(
        r,
        some
          ? `⌛ Some of ${label} is on Plex, but the rest still hasn't turned up, so I've stopped watching for it. The admins know about it.`
          : `⌛ ${label} still hasn't turned up, so I've stopped watching for it. The admins know about it.`,
      );
      await this.postLog(`⌛ Stopped tracking **${requestLabel(r)}** for <@${r.discordUserId}> after ${this.d.cfg.notify.trackDays} days; it never downloaded. Check ${this.app(r)}.`);
    }
  }

  /** A short DM, so their phone actually buzzes (card edits don't). */
  private async say(r: TrackedRequest, line: string, important = false) {
    const sent = await dm(this.d.client, r.discordUserId, line);
    if (sent || !important) return;
    const channelId = this.d.fallbackChannel?.();
    if (!channelId) return;
    const ch = await this.d.client.channels.fetch(channelId).catch(() => null);
    if (ch?.isSendable()) await (ch as SendableChannels).send({ content: `<@${r.discordUserId}> ${line}`, allowedMentions: { users: [r.discordUserId] } }).catch(() => undefined);
  }
}
