/**
 * Runs missing-content jobs. Nothing is ever deleted: it marks the episodes
 * (or movie) monitored, asks Sonarr/Radarr to search, then follows the grabs
 * through the download queue until each one is on Plex.
 *
 *   searching ─▶ downloading ─▶ done / partial / not_found / failed
 *
 * A season with nothing downloaded is searched as a season pack first, then
 * any episodes still without a grab are searched one by one. Whatever can't
 * be found or finished is reported to the member and posted in the log for
 * an admin. One tick every 30 seconds; everything is persisted, so restarts
 * are harmless.
 */
import type { Client, SendableChannels } from "discord.js";
import type { Config } from "../config.js";
import { dm, truncate } from "../core/discord.js";
import { ApiError } from "../core/http.js";
import { log } from "../core/logger.js";
import type { ArrApi } from "../redownload/arr.js";
import { friendlyQuality } from "../redownload/tracker.js";
import { ENDED, logButtons, logEmbed, trackerPayload, trackerSignature } from "./render.js";
import type { ItemState, MissingItem, MissingJob, MissingState, MissingStore } from "./store.js";

type Json = Record<string, any>;

const SEC = 1000;
const MIN = 60 * SEC;
const COMMAND_TIMEOUT = 10 * MIN;
const AFTER_SEARCH_GRACE = 30 * SEC; // grabs can land a moment after the search command finishes
const LOST_DOWNLOAD = 30 * MIN;
const IMPORT_STUCK = 30 * MIN;
const JOB_DEADLINE = 48 * 60 * MIN;
const APPROVAL_EXPIRY = 24 * 60 * MIN;
const TERMINAL: ItemState[] = ["imported", "not_found", "failed", "stuck"];
const FALLBACK_PER_TICK = 3;
const OFF_PROFILE_TAG = "off-profile";

/** Rejected only for quality (or custom-format score): fine as a stopgap. Language, size, wrong title, blocklisted etc. never are. */
export function qualityOnlyRejection(r: string): boolean {
  if (/language/i.test(r)) return false;
  return /\bnot wanted in profile\b/i.test(r) || /custom formats?.*\bbelow\b.*\bminimum\b/i.test(r);
}

const MIN_SIZE = { episode: 50 * 1024 ** 2, season: 200 * 1024 ** 2, movie: 300 * 1024 ** 2 };
const RESOLUTION_ORDER = [1080, 720, 2160, 576, 480];

/**
 * The best release outside the quality profile, for when nothing inside it
 * exists: 1080p, then 720p, then 4K, then SD; healthy torrents; not tiny.
 */
export function pickFallback(releases: Json[], kind: keyof typeof MIN_SIZE): Json | undefined {
  const text = (x: any) => (typeof x === "string" ? x : (x?.reason ?? x?.message ?? String(x)));
  const resOf = (r: Json) => Number(r.quality?.quality?.resolution) || Number(String(r.quality?.quality?.name ?? "").match(/(2160|1080|720|576|480)p/)?.[1]) || 0;
  const rank = (r: Json) => {
    const i = RESOLUTION_ORDER.indexOf(resOf(r));
    return i === -1 ? RESOLUTION_ORDER.length : i;
  };
  const health = (r: Json) => (String(r.protocol).toLowerCase() === "torrent" ? Math.min(r.seeders ?? 0, 50) : 50);
  return releases
    .filter((r) => (r.rejections ?? []).map(text).every(qualityOnlyRejection))
    .filter((r) => !(String(r.protocol).toLowerCase() === "torrent" && (r.seeders ?? 0) < 1))
    .filter((r) => (r.size ?? 0) >= MIN_SIZE[kind] && !/\bsample\b/i.test(r.title ?? ""))
    .filter((r) => (kind === "season" ? r.fullSeason : !r.fullSeason))
    .sort((a, b) => rank(a) - rank(b) || health(b) - health(a) || (a.size ?? 0) - (b.size ?? 0))[0];
}

export interface MissingDeps {
  api: { sonarr?: ArrApi; radarr?: ArrApi };
  mstore: MissingStore;
  client: Client;
  cfg: Config;
}

interface Editable {
  editReply(p: unknown): Promise<unknown>;
}

export class MissingEngine {
  private timer?: NodeJS.Timeout;
  private busy = new Set<number>();
  private replies = new Map<number, { i: Editable; at: number; header: string }>();
  private shown = new Map<number, string>();

  constructor(private readonly d: MissingDeps) {}

  start(intervalMs = 30 * SEC) {
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
    setTimeout(() => void this.tickAll(), 5000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tickAll() {
    for (const j of this.d.mstore.active()) await this.tick(j.id);
  }

  async tick(id: number): Promise<void> {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const job = this.d.mstore.job(id);
      if (!job) return;
      await this.step(job);
      if (job.errorCount) {
        job.errorCount = 0;
        this.save(job);
      }
    } catch (err) {
      await this.stepFailed(id, err);
    } finally {
      this.busy.delete(id);
    }
  }

  private async exclusive<T>(id: number, fn: (j: MissingJob) => Promise<T>): Promise<T | undefined> {
    const until = Date.now() + 60_000;
    while (this.busy.has(id)) {
      if (Date.now() > until) throw new Error("That one is busy right now. Try again in a minute.");
      await new Promise((r) => setTimeout(r, 100));
    }
    this.busy.add(id);
    try {
      const j = this.d.mstore.job(id);
      return j ? await fn(j) : undefined;
    } finally {
      this.busy.delete(id);
    }
  }

  private api(j: MissingJob): ArrApi {
    const a = this.d.api[j.target.app];
    if (!a) throw new Error(`${j.target.app} is no longer configured with an API key`);
    return a;
  }

  private async step(j: MissingJob) {
    if (j.state === "awaiting_approval") {
      if (Date.now() - j.createdAt > APPROVAL_EXPIRY) await this.finish(j, "denied", "Nobody approved it within 24 hours.");
      return;
    }
    if (j.state === "searching") return this.searching(j);
    if (j.state === "downloading") return this.downloading(j);
  }

  // ---- searching ------------------------------------------------------------------------------
  private async startSearch(j: MissingJob, ids: number[], kind: "season" | "episodes" | "movie") {
    const a = this.api(j);
    const t = j.target;
    // Monitor what they asked for, so the app wants it (and keeps wanting it).
    if (t.kind === "movie") await a.call(`/movie/editor`, { method: "PUT", body: { movieIds: [t.movieId], monitored: true } });
    else await a.call(`/episode/monitor`, { method: "PUT", body: { episodeIds: ids, monitored: true } });

    const body =
      kind === "movie"
        ? { name: "MoviesSearch", movieIds: [t.movieId] }
        : kind === "season"
          ? { name: "SeasonSearch", seriesId: t.seriesId, seasonNumber: t.seasonNumber }
          : { name: "EpisodeSearch", episodeIds: ids };
    const cmd = await a.call<Json>(`/command`, { method: "POST", body });
    j.phase = kind;
    j.commandId = cmd.id;
    j.commandStartedAt = Date.now();
    j.commandFinishedAt = undefined;
    j.searchStartedAt ??= Date.now();
    const what = kind === "season" ? "a full-season pack" : kind === "movie" ? "the movie" : `${ids.length} episode${ids.length === 1 ? "" : "s"}`;
    await this.event(j, `🔎 Searching for ${what}`);
  }

  private async searching(j: MissingJob) {
    if (j.phase === "fallback") return this.fallback(j);
    if (!j.commandId) {
      const ids = j.items.map((i) => i.id);
      const kind = j.target.kind === "movie" ? "movie" : j.target.wholeSeason && ids.length > 1 ? "season" : "episodes";
      return this.startSearch(j, ids, kind);
    }
    const a = this.api(j);
    const cmd: Json = await a.call<Json>(`/command/${j.commandId}`).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return { status: "completed" } as Json; // the app forgot it: treat as done
      throw err;
    });
    const finished = /^(completed|failed|aborted|cancelled|orphaned)$/i.test(String(cmd.status ?? ""));
    await this.refresh(j);
    if (!finished && Date.now() - (j.commandStartedAt ?? 0) < COMMAND_TIMEOUT) return this.save(j);
    j.commandFinishedAt ??= Date.now();
    if (Date.now() - j.commandFinishedAt < AFTER_SEARCH_GRACE) return this.save(j);

    const ungrabbed = j.items.filter((i) => i.state === "searching");
    if (j.phase === "season" && ungrabbed.length) {
      // No season pack (or it didn't cover everything): try the episodes one by one.
      await this.event(j, `↪️ No season pack for ${ungrabbed.length === j.items.length ? "the season" : `${ungrabbed.length} episodes`}; trying them one by one`);
      return this.startSearch(
        j,
        ungrabbed.map((i) => i.id),
        "episodes",
      );
    }
    if (ungrabbed.length) {
      // Nothing in the quality profile: rather than leave them with nothing, look at other qualities.
      j.phase = "fallback";
      j.fallbackQueue = ungrabbed.map((i) => i.id);
      for (const it of ungrabbed) it.message = String(cmd.status ?? "").toLowerCase() === "failed" ? `search failed: ${truncate(String(cmd.message ?? cmd.exception ?? ""), 80)}` : undefined;
      await this.event(j, `🔄 Nothing in the usual quality for ${ungrabbed.map((i) => i.label.split(" ·")[0]).join(", ")}; trying other qualities`);
      return;
    }
    if (j.items.every((i) => TERMINAL.includes(i.state))) return this.finish(j);
    await this.event(j, "⬇️ Downloading", "downloading");
  }

  /** Interactive searches for what the normal search couldn't find, accepting other qualities. A few per tick. */
  private async fallback(j: MissingJob) {
    const a = this.api(j);
    const t = j.target;
    await this.refresh(j); // late grabs from the normal search still count
    const pending = () => (j.fallbackQueue ?? []).filter((id) => j.items.find((i) => i.id === id)?.state === "searching");
    j.fallbackQueue = pending();
    const got: MissingItem[] = [];

    const take = async (release: Json, items: MissingItem[]) => {
      await a.call(`/release`, { method: "POST", body: { guid: release.guid, indexerId: release.indexerId }, timeoutMs: 60_000 });
      const offProfile = (release.rejections ?? []).length > 0;
      for (const it of items) {
        if (offProfile) it.offProfile = { quality: release.quality?.quality?.name ?? "other quality", release: release.title };
        it.state = "downloading";
        it.grabbedAt = Date.now();
        it.message = undefined;
        if (offProfile) got.push(it);
      }
      j.fallbackQueue = (j.fallbackQueue ?? []).filter((id) => !items.some((i) => i.id === id));
    };

    // A whole missing season: one off-profile season pack beats a dozen single episodes.
    if (t.kind === "episodes" && t.wholeSeason && !j.fallbackSeasonTried && j.fallbackQueue.length === j.items.length && j.items.length > 1) {
      j.fallbackSeasonTried = true;
      const rels = await a.call<Json[]>(`/release`, { query: { seriesId: t.seriesId, seasonNumber: t.seasonNumber }, timeoutMs: 120_000 });
      const pack = pickFallback(rels, "season");
      if (pack) await take(pack, j.items.filter((i) => i.state === "searching"));
    }

    for (const id of [...j.fallbackQueue].slice(0, FALLBACK_PER_TICK)) {
      const it = j.items.find((i) => i.id === id)!;
      const rels = await a.call<Json[]>(`/release`, { query: t.kind === "movie" ? { movieId: t.movieId } : { episodeId: id }, timeoutMs: 120_000 });
      const best = pickFallback(rels, t.kind === "movie" ? "movie" : "episode");
      if (best) {
        try {
          await take(best, [it]);
          continue;
        } catch (err) {
          it.message = `couldn't grab the other-quality copy: ${truncate((err as Error).message, 80)}`;
        }
      }
      it.state = "not_found";
      it.message ??= "nothing out there in any quality";
      j.fallbackQueue = j.fallbackQueue.filter((x) => x !== id);
    }

    if (got.length) {
      await this.tagOffProfile(j);
      await this.alertOffProfile(j, got);
      await this.event(j, `🟠 Grabbed another quality for ${got.map((i) => i.label.split(" ·")[0]).join(", ")}`);
    }
    if (j.fallbackQueue.length) {
      this.save(j);
      return this.updateTracker(j);
    }
    const none = j.items.filter((i) => i.state === "not_found");
    if (none.length) await this.event(j, `😕 Nothing in any quality for ${none.map((i) => i.label.split(" ·")[0]).join(", ")}`);
    if (j.items.every((i) => TERMINAL.includes(i.state))) return this.finish(j);
    await this.event(j, "⬇️ Downloading", "downloading");
  }

  private tagIds = new Map<string, number>();

  /** Tags the show/movie "off-profile" in Sonarr/Radarr so admins can find what needs a proper copy later. */
  private async tagOffProfile(j: MissingJob) {
    const a = this.api(j);
    try {
      let tagId = this.tagIds.get(j.target.app);
      if (tagId === undefined) {
        const tags = await a.call<Json[]>(`/tag`);
        tagId = tags.find((x) => String(x.label).toLowerCase() === OFF_PROFILE_TAG)?.id ?? (await a.call<Json>(`/tag`, { method: "POST", body: { label: OFF_PROFILE_TAG } })).id;
        this.tagIds.set(j.target.app, tagId!);
      }
      if (j.target.kind === "movie") await a.call(`/movie/editor`, { method: "PUT", body: { movieIds: [j.target.movieId], tags: [tagId], applyTags: "add" } });
      else await a.call(`/series/editor`, { method: "PUT", body: { seriesIds: [j.target.seriesId], tags: [tagId], applyTags: "add" } });
    } catch (err) {
      log.warn(`missing #${j.id}: couldn't tag it ${OFF_PROFILE_TAG}: ${(err as Error).message}`);
    }
  }

  /** Tells admins exactly what was grabbed outside the profile (its own message, so it's noticed). */
  private async alertOffProfile(j: MissingJob, items: MissingItem[]) {
    const id = this.logChannelId();
    if (!id) return;
    const ch = await this.d.client.channels.fetch(id).catch(() => null);
    if (!ch?.isSendable()) return;
    const app = j.target.app === "sonarr" ? "Sonarr" : "Radarr";
    const lines = items.map((i) => `• ${i.label}: **${i.offProfile!.quality}** (\`${truncate(i.offProfile!.release, 90)}\`)`);
    await (ch as SendableChannels)
      .send({
        content: truncate(
          `🟠 **${j.target.label}** (asked for by <@${j.discordUserId}>): nothing was out there in your quality profile, so I grabbed another quality to get it on Plex now:\n${lines.join("\n")}\n` +
            `-# Tagged **${OFF_PROFILE_TAG}** in ${app}. If upgrades are allowed in that quality profile, ${app} replaces it with your usual quality when that turns up.`,
          2000,
        ),
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  }

  // ---- downloading ------------------------------------------------------------------------------
  private async downloading(j: MissingJob) {
    await this.refresh(j);
    const now = Date.now();
    for (const it of j.items.filter((i) => i.state === "downloading")) {
      if (it.blockedSince && now - it.blockedSince > IMPORT_STUCK) {
        it.state = "stuck";
        await this.event(j, `🧰 ${it.label.split(" ·")[0]} downloaded but won't import: ${truncate(it.message ?? "unknown reason", 100)}`);
        continue;
      }
      const lastSign = Math.max(it.lastSeenAt ?? 0, it.grabbedAt ?? 0);
      if (lastSign && now - lastSign > LOST_DOWNLOAD) {
        it.state = "failed";
        it.message ??= "the download disappeared without importing";
        await this.event(j, `⚠️ ${it.label.split(" ·")[0]}: ${it.message}`);
        continue;
      }
      if (now - (j.searchStartedAt ?? j.createdAt) > JOB_DEADLINE) {
        it.state = "failed";
        it.message = "still not done after 48 hours";
      }
    }
    if (j.items.every((i) => TERMINAL.includes(i.state))) return this.finish(j);
    this.save(j);
    await this.updateTracker(j);
  }

  /** Reads files, grabs and the queue, and updates each item. */
  private async refresh(j: MissingJob) {
    const a = this.api(j);
    const t = j.target;
    const since = (j.searchStartedAt ?? j.createdAt) - MIN;
    let hasFile: (id: number) => boolean;
    let grabs: Json[];
    let queue: Json[];
    if (t.kind === "movie") {
      const [mv, hist, q] = await Promise.all([
        a.call<Json>(`/movie/${t.movieId}`),
        a.call<Json[]>(`/history/movie`, { query: { movieId: t.movieId } }),
        a.call<Json[]>(`/queue/details`, { query: { movieId: t.movieId } }),
      ]);
      hasFile = () => !!mv.hasFile;
      grabs = hist.filter((h) => h.eventType === "grabbed" && Date.parse(h.date) >= since).map((h) => ({ ...h, itemId: t.movieId }));
      queue = q.map((x) => ({ ...x, itemId: t.movieId }));
    } else {
      const ids = j.items.map((i) => i.id);
      const [eps, hist, q] = await Promise.all([
        a.call<Json[]>(`/episode`, { query: { seriesId: t.seriesId, seasonNumber: t.seasonNumber } }),
        a.call<Json[]>(`/history/series`, { query: { seriesId: t.seriesId, seasonNumber: t.seasonNumber } }),
        a.call<Json[]>(`/queue/details?seriesId=${t.seriesId}&${ids.map((id) => `episodeIds=${id}`).join("&")}`),
      ]);
      const files = new Map(eps.map((e) => [e.id as number, !!e.hasFile]));
      hasFile = (id) => files.get(id) ?? false;
      grabs = hist.filter((h) => h.eventType === "grabbed" && Date.parse(h.date) >= since).map((h) => ({ ...h, itemId: h.episodeId }));
      queue = q.map((x) => ({ ...x, itemId: x.episodeId }));
    }

    for (const it of j.items) {
      if (it.state === "imported") continue;
      if (hasFile(it.id)) {
        Object.assign(it, { state: "imported", progress: undefined, eta: undefined, blockedSince: undefined, message: undefined });
        continue;
      }
      if (it.state === "not_found" || it.state === "failed" || it.state === "stuck") {
        // A late grab (e.g. the app retried by itself) brings it back.
        const late = grabs.find((g) => g.itemId === it.id && Date.parse(g.date) > (it.grabbedAt ?? 0) && g.downloadId !== it.downloadId);
        if (!late) continue;
        it.state = "downloading";
        it.message = undefined;
      }
      const grab = grabs.filter((g) => g.itemId === it.id).sort((x, y) => Date.parse(y.date) - Date.parse(x.date))[0];
      if (grab && grab.downloadId !== it.downloadId) {
        it.downloadId = grab.downloadId;
        it.grabbedAt = Date.parse(grab.date);
        it.blockedSince = undefined;
        if (it.state === "searching") it.state = "downloading";
      }
      const item = queue.find((x) => x.itemId === it.id && (!it.downloadId || x.downloadId === it.downloadId)) ?? queue.find((x) => x.itemId === it.id);
      if (!item) continue;
      if (it.state === "searching") it.state = "downloading";
      it.downloadId ??= item.downloadId;
      it.lastSeenAt = Date.now();
      it.progress = item.size > 0 ? Math.round(((item.size - (item.sizeleft ?? 0)) / item.size) * 100) : undefined;
      it.eta = item.estimatedCompletionTime ?? undefined;
      it.queueStatus = String(item.trackedDownloadStatus ?? "").toLowerCase() === "warning" ? "warning" : item.status;
      const state = String(item.trackedDownloadState ?? "").toLowerCase();
      const messages: string[] = (item.statusMessages ?? []).flatMap((m: Json) => m.messages ?? []);
      if ((state === "importblocked" || state === "importpending" || state === "failedpending") && messages.length) {
        it.blockedSince ??= Date.now();
        it.message = messages[0];
      } else it.blockedSince = undefined;
    }
  }

  // ---- endings ------------------------------------------------------------------------------------
  async finish(j: MissingJob, forced?: Extract<MissingState, "cancelled" | "denied" | "failed">, outcome?: string, by?: string) {
    const imported = j.items.filter((i) => i.state === "imported").length;
    const state: MissingState =
      forced ?? (imported === j.items.length ? "done" : imported > 0 ? "partial" : j.items.every((i) => i.state === "not_found") ? "not_found" : "failed");
    j.finishedAt = Date.now();
    if (outcome) j.outcome = outcome;
    if (by) j.endedBy = by;
    const text: Record<string, string> = {
      done: "✅ Everything's on Plex",
      partial: `🟡 ${imported} of ${j.items.length} arrived`,
      not_found: "😕 Nothing could be found",
      failed: "⚠️ Gave up",
      cancelled: `🛑 Cancelled${by ? ` by <@${by}>` : ""}`,
      denied: `🚫 Denied${by ? ` by <@${by}>` : ""}`,
    };
    await this.event(j, text[state], state);
    await this.notifyRequester(j);
    if (state === "partial" || state === "not_found" || state === "failed") await this.alertAdmins(j);
  }

  cancel(id: number, by: string): Promise<string> {
    return this.exclusive(id, async (j) => {
      if (ENDED.includes(j.state)) return "That one's already finished.";
      // Stop the downloads that are still going; anything already on Plex stays.
      const a = this.d.api[j.target.app];
      if (a && j.state === "downloading") {
        const queue = await a
          .call<Json[]>(j.target.kind === "movie" ? `/queue/details?movieId=${j.target.movieId}` : `/queue/details?seriesId=${j.target.seriesId}`)
          .catch(() => [] as Json[]);
        const ours = new Set(j.items.filter((i) => i.state === "downloading" && i.downloadId).map((i) => i.downloadId));
        for (const q of queue.filter((x) => ours.has(x.downloadId))) await a.call(`/queue/${q.id}`, { method: "DELETE", query: { removeFromClient: true, blocklist: false } }).catch(() => undefined);
      }
      await this.finish(j, "cancelled", undefined, by);
      return "Cancelled. Anything that already finished is still on Plex.";
    }).then((r) => r ?? "I can't find that one any more.");
  }

  approve(id: number, by: string): Promise<string> {
    return this.exclusive(id, async (j) => {
      if (j.state !== "awaiting_approval") return "That one isn't waiting for approval any more.";
      j.approvedBy = by;
      await this.event(j, `✅ Approved by <@${by}>`, "searching");
      return "Approved. Searching now.";
    }).then(async (r) => {
      if (r?.startsWith("Approved")) await this.tick(id);
      return r ?? "I can't find that one any more.";
    });
  }

  deny(id: number, by: string, reason?: string): Promise<string> {
    return this.exclusive(id, async (j) => {
      if (j.state !== "awaiting_approval") return "That one isn't waiting for approval any more.";
      await this.finish(j, "denied", reason, by);
      return "Denied. They've been told.";
    }).then((r) => r ?? "I can't find that one any more.");
  }

  private async stepFailed(id: number, err: unknown) {
    const msg = (err as Error).message.slice(0, 150);
    const unreachable = err instanceof ApiError && err.unreachable;
    if (unreachable) log.warn(`missing #${id}: ${msg} (will retry)`);
    else log.error(`missing #${id}: step failed`, err);
    const j = this.d.mstore.job(id);
    if (!j) return;
    j.errorCount = (j.errorCount ?? 0) + 1;
    if (j.errorCount >= (unreachable ? 720 : 10)) {
      for (const it of j.items.filter((i) => !TERMINAL.includes(i.state))) {
        it.state = "failed";
        it.message = `kept hitting an error: ${msg}`;
      }
      return this.finish(j);
    }
    await this.event(j, `⚠️ ${msg} (will retry)`);
  }

  // ---- messages -------------------------------------------------------------------------------------
  private save(j: MissingJob, state?: MissingState) {
    if (state) j.state = state;
    this.d.mstore.save(j);
  }

  private async event(j: MissingJob, text: string, state?: MissingState) {
    const last = j.events.at(-1);
    if (last?.text === text) last.at = Date.now();
    else j.events.push({ at: Date.now(), text });
    if (j.events.length > 60) j.events.splice(1, j.events.length - 60);
    this.save(j, state);
    log.info(`missing #${j.id} (${j.target.label}): ${text.replace(/<@\d+>/g, "")}`);
    await this.updateLog(j);
    await this.updateTracker(j);
  }

  private logChannelId() {
    return this.d.cfg.channels.redownloadLog ?? this.d.cfg.channels.admin;
  }

  async updateLog(j: MissingJob) {
    const payload = { embeds: [logEmbed(j)], components: logButtons(j), allowedMentions: { parse: [] as [] } };
    try {
      if (j.logChannelId && j.logMessageId) {
        const ch = await this.d.client.channels.fetch(j.logChannelId).catch(() => null);
        if (ch && "messages" in ch) {
          const m = await ch.messages.fetch(j.logMessageId).catch(() => null);
          if (m) return void (await m.edit(payload));
        }
      }
      const id = this.logChannelId();
      if (!id) return;
      const ch = await this.d.client.channels.fetch(id).catch(() => null);
      if (!ch?.isSendable()) return;
      const m = await (ch as SendableChannels).send(payload);
      const fresh = this.d.mstore.job(j.id);
      j.logChannelId = m.channelId;
      j.logMessageId = m.id;
      if (fresh) {
        fresh.logChannelId = m.channelId;
        fresh.logMessageId = m.id;
        this.d.mstore.save(fresh);
      }
    } catch (err) {
      log.warn(`missing #${j.id}: couldn't update the log entry: ${(err as Error).message}`);
    }
  }

  /** What couldn't be got, posted as its own message so admins notice (edits don't notify). */
  private async alertAdmins(j: MissingJob) {
    const id = this.logChannelId();
    if (!id) return;
    const ch = await this.d.client.channels.fetch(id).catch(() => null);
    if (!ch?.isSendable()) return;
    const app = j.target.app === "sonarr" ? "Sonarr" : "Radarr";
    const bad = j.items.filter((i) => i.state !== "imported");
    const lines = bad.map((i) => `• ${i.label}: ${i.message ?? i.state.replace("_", " ")}`);
    const link = j.logChannelId && j.logMessageId ? ` ([details](https://discord.com/channels/${this.d.cfg.guildId}/${j.logChannelId}/${j.logMessageId}))` : "";
    await (ch as SendableChannels)
      .send({
        content: truncate(
          `🔎 <@${j.discordUserId}> asked for **${j.target.label}** and I couldn't get ${bad.length === j.items.length ? "it" : `${bad.length} of ${j.items.length}`}${link}:\n${lines.join("\n")}\n-# Check ${app} → Wanted / Activity, or grab it manually.`,
          2000,
        ),
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  }

  private async notifyRequester(j: MissingJob) {
    if (j.endedBy === j.discordUserId) return;
    const label = `**${j.target.label}**`;
    const imported = j.items.filter((i) => i.state === "imported").length;
    const text: Record<string, string> = {
      done: j.target.kind === "movie" ? `✅ ${label} is on Plex now. Enjoy!` : `✅ The missing episode${j.items.length === 1 ? "" : "s"} of ${label} ${j.items.length === 1 ? "is" : "are"} on Plex now!`,
      partial: `🟡 ${imported} of ${j.items.length} missing episodes of ${label} are on Plex now. I couldn't get the rest, and I've let the admins know.`,
      not_found: `😕 I couldn't find ${label} anywhere right now. I've let the admins know so they can take a look.`,
      failed: `⚠️ I couldn't finish getting ${label}. I've let the admins know.`,
      cancelled: `🛑 An admin stopped the search for ${label}.`,
      denied: `🚫 Your request for ${label} wasn't approved.`,
    };
    let line = text[j.state];
    if (!line) return;
    const other = j.items.filter((i) => i.state === "imported" && i.offProfile);
    if (other.length && (j.state === "done" || j.state === "partial")) {
      const q = [...new Set(other.map((i) => friendlyQuality(i.offProfile!.quality)))].join("/");
      line += ` ${j.items.length === 1 ? "It's" : other.length === j.items.length ? "They're" : "Some are"} a ${q} copy for now, since that's all that was out there.`;
    }
    const sent = await dm(this.d.client, j.discordUserId, line);
    if (!sent && this.d.cfg.channels.notify) {
      const ch = await this.d.client.channels.fetch(this.d.cfg.channels.notify).catch(() => null);
      if (ch?.isSendable()) await (ch as SendableChannels).send({ content: `<@${j.discordUserId}> ${line}`, allowedMentions: { users: [j.discordUserId] } }).catch(() => undefined);
    }
  }

  // ---- the member's tracker --------------------------------------------------------------------------
  attachReply(id: number, i: Editable, header: string) {
    this.replies.set(id, { i, at: Date.now(), header });
  }

  /** DMs the tracker card. False when their DMs are closed. */
  async startTracker(j: MissingJob): Promise<boolean> {
    try {
      const user = await this.d.client.users.fetch(j.discordUserId);
      const m = await user.send(trackerPayload(j));
      j.trackerChannelId = m.channelId;
      j.trackerMessageId = m.id;
      const fresh = this.d.mstore.job(j.id);
      if (fresh) {
        fresh.trackerChannelId = m.channelId;
        fresh.trackerMessageId = m.id;
        this.d.mstore.save(fresh);
      }
      this.shown.set(j.id, trackerSignature(j));
      return true;
    } catch {
      return false;
    }
  }

  async updateTracker(j: MissingJob, force = false) {
    const sig = trackerSignature(j);
    if (!force && this.shown.get(j.id) === sig) return;
    this.shown.set(j.id, sig);
    const payload = trackerPayload(j);
    const reply = this.replies.get(j.id);
    if (reply) {
      if (Date.now() - reply.at > 14 * MIN) this.replies.delete(j.id);
      else await reply.i.editReply({ ...payload, content: ENDED.includes(j.state) ? "" : reply.header }).catch(() => this.replies.delete(j.id));
    }
    if (j.trackerChannelId && j.trackerMessageId) {
      try {
        const ch = await this.d.client.channels.fetch(j.trackerChannelId);
        if (ch && "messages" in ch) await (await ch.messages.fetch(j.trackerMessageId)).edit(payload);
      } catch {
        j.trackerMessageId = undefined; // deleted or DMs closed: /missing still shows it
      }
    }
    if (ENDED.includes(j.state)) {
      this.replies.delete(j.id);
      this.shown.delete(j.id);
    }
  }
}

export type { MissingItem };
