/**
 * Batches inbound events per channel, dedupes them, @-mentions requesters and
 * posts one message per channel per window (NOTIFY_BATCH_SECONDS, default 60).
 */
import type { Client, EmbedBuilder, SendableChannels } from "discord.js";
import type { Config } from "../config.js";
import type { Store } from "../core/db.js";
import { log } from "../core/logger.js";
import type { OptCategory, RoleDirectory } from "../core/roles.js";
import { TtlCache } from "../core/ttlCache.js";
import type { AlertEvent, InboundEvent, MediaEvent } from "./events.js";
import { mergeEvents, readyLines, renderAlerts, renderSingle, renderSummary, type RenderItem } from "./render.js";

interface Bucket {
  media: Map<string, MediaEvent>;
  alerts: Map<string, AlertEvent>;
  timer?: NodeJS.Timeout;
}

const ALERT_DEDUPE_MS = 30 * 60_000;

export class Notifier {
  private buckets = new Map<string, Bucket>();
  private recentMedia: TtlCache<string, true>;
  private recentAlerts = new TtlCache<string, true>(ALERT_DEDUPE_MS);
  private stopped = false;
  private listeners: Array<(ev: InboundEvent) => void> = [];

  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly roles?: RoleDirectory,
  ) {
    this.recentMedia = new TtlCache(Math.max(1, cfg.notify.dedupeHours * 3_600_000), 5000);
  }

  /** Music can have its own channel (e.g. visible only to the Music role). */
  channelFor(ev: MediaEvent): string | undefined {
    const music = ev.kind === "album" || ev.kind === "track";
    return (music ? this.cfg.channels.music : undefined) ?? this.cfg.channels.notify;
  }
  get alertChannel() {
    return this.cfg.channels.admin ?? this.cfg.channels.status;
  }

  /** Lets a module react to events itself (e.g. /report DMs on resolved issues). */
  subscribe(fn: (ev: InboundEvent) => void): void {
    this.listeners.push(fn);
  }

  /** Queue events; they're posted when the channel's batch window closes. */
  publish(events: InboundEvent[]): void {
    for (const ev of events) {
      for (const fn of this.listeners) {
        try {
          fn(ev);
        } catch (err) {
          log.error("notify: event listener failed", err);
        }
      }
      if (ev.type === "issue") continue;
      const channelId = ev.type === "media" ? this.channelFor(ev) : this.alertChannel;
      if (!channelId) {
        log.debug(`notify: no channel configured for ${ev.type} event "${ev.dedupeKey}", dropping`);
        continue;
      }
      const bucket = this.bucket(channelId);
      if (ev.type === "media") {
        const prev = bucket.media.get(ev.dedupeKey);
        bucket.media.set(ev.dedupeKey, prev ? mergeEvents(prev, ev) : ev);
      } else if (!bucket.alerts.has(ev.dedupeKey)) {
        bucket.alerts.set(ev.dedupeKey, ev);
      }
    }
  }

  private bucket(channelId: string): Bucket {
    let b = this.buckets.get(channelId);
    if (!b) {
      b = { media: new Map(), alerts: new Map() };
      this.buckets.set(channelId, b);
    }
    if (!b.timer && !this.stopped) {
      b.timer = setTimeout(() => void this.flush(channelId), this.cfg.notify.batchSeconds * 1000);
      b.timer.unref();
    }
    return b;
  }

  async flush(channelId: string): Promise<void> {
    const bucket = this.buckets.get(channelId);
    if (!bucket) return;
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = undefined;

    if (!this.client.isReady()) {
      // Discord not connected yet: try again shortly, keep the events.
      if (!this.stopped) bucket.timer = setTimeout(() => void this.flush(channelId), 10_000).unref();
      return;
    }
    this.buckets.delete(channelId);

    const fresh: RenderItem[] = [];
    const readyOnly: RenderItem[] = [];
    const notifiedIds: number[] = [];

    for (const ev of bucket.media.values()) {
      const pending = ev.confirms && ev.match ? this.store.findPending(ev.match) : [];
      const requesters = [...new Set(pending.map((p) => p.discordUserId))];
      notifiedIds.push(...pending.map((p) => p.id));
      const item = { event: ev, requesters };
      if (this.recentMedia.has(ev.dedupeKey)) {
        // Already announced (e.g. Radarr reported it earlier); only ping whoever asked for it.
        if (requesters.length) readyOnly.push(item);
      } else {
        fresh.push(item);
      }
    }

    const alerts = [...bucket.alerts.values()].filter((a) => !this.recentAlerts.has(a.dedupeKey));

    const embeds: EmbedBuilder[] = [];
    if (fresh.length === 1) embeds.push(renderSingle(fresh[0]));
    else if (fresh.length > 1) embeds.push(renderSummary(fresh));
    if (alerts.length) embeds.push(renderAlerts(alerts));
    // Opt-in role pings for the categories in this batch, then personal "your request is ready" lines.
    const roleIds = [...new Set(fresh.map((it) => categoryOf(it.event)).map((c) => this.roles?.get(c)).filter((r): r is string => Boolean(r)))];
    const content = [roleIds.map((r) => `<@&${r}>`).join(" "), readyLines([...fresh, ...readyOnly])].filter(Boolean).join("\n");
    if (!embeds.length && !content) return;

    const userIds = [...new Set([...fresh, ...readyOnly].flatMap((i) => i.requesters))];
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isSendable()) throw new Error(`channel ${channelId} is not a text channel the bot can post in`);
      await (channel as SendableChannels).send({
        content: content || undefined,
        embeds,
        allowedMentions: { users: userIds, roles: roleIds, parse: [] },
      });
      for (const it of fresh) this.recentMedia.set(it.event.dedupeKey, true);
      for (const a of alerts) this.recentAlerts.set(a.dedupeKey, true);
      this.store.markNotified(notifiedIds);
      log.info(`notify: posted ${fresh.length} new item(s), ${readyOnly.length} ready ping(s), ${alerts.length} alert(s) to ${channelId}`);
    } catch (err) {
      // Requests stay pending, so the reconciler will retry the mention later.
      log.error(`notify: failed to post to channel ${channelId}: ${(err as Error).message}`);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.buckets.keys()].map((id) => this.flush(id)));
  }

  stop(): void {
    this.stopped = true;
    for (const b of this.buckets.values()) if (b.timer) clearTimeout(b.timer);
  }
}

export function categoryOf(ev: MediaEvent): OptCategory {
  if (ev.kind === "movie") return "movies";
  if (ev.kind === "album" || ev.kind === "track") return "music";
  return "tv";
}
