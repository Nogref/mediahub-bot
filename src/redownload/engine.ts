/**
 * The redownload state machine. One tick per minute moves every active job
 * one step forward, and everything is persisted, so restarts are harmless.
 *
 *   grabbing ─▶ downloading ─▶ swapping ─▶ importing ─▶ done
 *        ▲            │ download failed / bad import / timeout
 *        └────────────┘ (next release, up to REDOWNLOAD_MAX_ATTEMPTS; old file untouched)
 *
 * The old file is only deleted once the new download has fully finished and
 * the app says the *only* thing stopping the import is the existing file.
 * Even then it goes to the app's recycling bin, which must be configured.
 */
import type { Client, SendableChannels } from "discord.js";
import { TtlCache } from "../core/ttlCache.js";
import type { AlertEvent } from "../notify/events.js";
import type { Config } from "../config.js";
import { dm } from "../core/discord.js";
import { ApiError } from "../core/http.js";
import { log } from "../core/logger.js";
import type { Notifier } from "../notify/notifier.js";
import type { Adapters } from "./arr.js";
import { normRelease } from "./arr.js";
import { logButtons, logEmbed } from "./log.js";
import { isHarmlessMessage, isNotUpgradeMessage, pickCandidates, readyToSwap } from "./select.js";
import type { Job, JobState, RedownloadStore } from "./store.js";
import type { QueueItem } from "./types.js";

const MINUTE = 60_000;
const SUPPRESS_ANNOUNCE_MS = 12 * 60 * MINUTE;
const LOST_DOWNLOAD_MS = 15 * MINUTE;
const IMPORT_STUCK_MS = 20 * MINUTE;
const APPROVAL_EXPIRY_MS = 24 * 60 * MINUTE;

export interface EngineDeps {
  adapters: Adapters;
  rstore: RedownloadStore;
  notifier: Notifier;
  client: Client;
  cfg: Config;
}

export class RedownloadEngine {
  private timer?: NodeJS.Timeout;
  private busy = new Set<number>();
  /** Release titles / download ids whose app alerts the redownload log already covers. */
  private muted = new TtlCache<string, true>(6 * 60 * MINUTE, 5000);

  constructor(private readonly d: EngineDeps) {
    d.notifier.addAlertFilter((ev) => this.coversAlert(ev));
  }

  private mute(...tokens: Array<string | undefined>) {
    for (const t of tokens) {
      if (!t) continue;
      this.muted.set(t, true);
      const n = normRelease(t);
      if (n.length >= 8) this.muted.set(n, true);
    }
  }

  /** "Manual interaction required", "download failed"… for downloads a redownload is handling. */
  coversAlert(ev: AlertEvent): boolean {
    if (!/^(Radarr|Sonarr|Lidarr)$/.test(ev.source ?? "")) return false;
    const id = ev.dedupeKey.split(":").pop() ?? "";
    const has = (k: string) => k.length >= 8 && this.muted.has(k);
    return (id.length > 0 && this.muted.has(id)) || has(normRelease(ev.message)) || has(normRelease(ev.title));
  }

  start(intervalMs = MINUTE) {
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
    setTimeout(() => void this.tickAll(), 5000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tickAll(): Promise<void> {
    for (const job of this.d.rstore.activeJobs()) await this.tick(job.id);
  }

  /** Advances one job; never throws. Skipped if something else is working on it. */
  async tick(id: number): Promise<void> {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const job = this.d.rstore.job(id);
      if (!job) return;
      const hadErrors = job.errorCount ?? 0;
      await this.step(job);
      if (hadErrors) {
        const fresh = this.d.rstore.job(id);
        if (fresh?.errorCount) {
          fresh.errorCount = 0;
          this.d.rstore.saveJob(fresh);
        }
      }
    } catch (err) {
      await this.stepFailed(id, err);
    } finally {
      this.busy.delete(id);
    }
  }

  /**
   * Errors are retried every minute, but not forever: 10 in a row (or 6 hours
   * of an app being unreachable) ends the job. If files were already swapped,
   * an admin is called instead of giving up silently.
   */
  private async stepFailed(id: number, err: unknown) {
    const msg = (err as Error).message.slice(0, 150);
    const unreachable = err instanceof ApiError && err.unreachable;
    if (unreachable) log.warn(`redownload #${id}: ${msg} (will retry)`);
    else log.error(`redownload #${id}: step failed`, err);
    const job = this.d.rstore.job(id);
    if (!job) return;
    job.errorCount = (job.errorCount ?? 0) + 1;
    if (job.errorCount >= (unreachable ? 360 : 10)) {
      job.errorCount = 0;
      if (job.changedFiles || job.state === "swapping" || job.state === "importing") {
        const a = this.d.adapters[job.target.app];
        job.outcome = `Kept failing after the old copy was moved to ${a?.name ?? "the app"}'s recycling bin (${msg}). Finish the import in ${a?.name ?? "the app"} → Activity → Queue, or restore the old file.`;
        await this.event(job, `🆘 Repeated errors: ${msg}`, "needs_admin");
        await this.alertAdmins(job);
      } else {
        await this.finish(job, "failed", `Kept hitting an error: ${msg}`);
      }
      return;
    }
    await this.event(job, `⚠️ ${msg} (will retry)`);
  }

  /** Runs an admin/member action on a job without racing the background worker. */
  private async exclusive<T>(id: number, fn: (job: Job) => Promise<T>): Promise<T | undefined> {
    const until = Date.now() + 60_000;
    while (this.busy.has(id)) {
      if (Date.now() > until) throw new Error("That redownload is busy right now. Try again in a minute.");
      await new Promise((r) => setTimeout(r, 100));
    }
    this.busy.add(id);
    try {
      const job = this.d.rstore.job(id);
      return job ? await fn(job) : undefined;
    } finally {
      this.busy.delete(id);
    }
  }

  private adapter(job: Job) {
    const a = this.d.adapters[job.target.app];
    if (!a) throw new Error(`${job.target.app} is no longer configured with an API key`);
    return a;
  }

  private async step(job: Job): Promise<void> {
    switch (job.state) {
      case "awaiting_approval":
        if (Date.now() - job.createdAt > APPROVAL_EXPIRY_MS) await this.finish(job, "denied", "Nobody approved it within 24 hours.");
        return;
      case "grabbing":
        return this.startAttempt(job);
      case "downloading":
        return this.checkDownload(job);
      case "swapping":
        return this.swap(job);
      case "importing":
      case "needs_admin":
        return this.checkImport(job);
      default:
        return;
    }
  }

  // ---- attempts ----------------------------------------------------------------
  private async startAttempt(job: Job): Promise<void> {
    const a = this.adapter(job);
    if (job.attempt >= this.d.cfg.redownload.maxAttempts) {
      return this.finish(job, "failed", `Tried ${job.attempt} release${job.attempt === 1 ? "" : "s"}; none worked.`);
    }
    let next = job.candidates.find((c) => !job.tried.some((t) => normRelease(t) === normRelease(c.title)));
    if (!next) {
      // Out of pre-picked releases: search once more for anything new.
      const releases = await a.search(job.target);
      const fresh = pickCandidates(releases, {
        kind: job.target.kind,
        excludeTitles: [...job.tried, ...job.oldGrabs.map((g) => g.title), ...job.oldFiles.map((f) => f.releaseTitle ?? "")],
        currentSize: job.oldFiles.reduce((s, f) => s + f.size, 0),
      });
      job.candidates.push(...fresh);
      next = fresh[0];
      if (!next) return this.finish(job, "failed", "No other usable release is available right now.");
    }
    job.attempt++;
    job.tried.push(next.title);
    this.mute(next.title);
    job.current = next;
    job.downloadId = undefined;
    job.progress = undefined;
    job.attemptStartedAt = Date.now();
    try {
      await a.grab(next);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        // The app's search cache expired or the indexer refused: refresh and try that same release once.
        const again = (await a.search(job.target)).find((r) => r.guid === next!.guid);
        if (again) await a.grab(again);
        else {
          job.attempt--; // never got started, so it doesn't use up an attempt
          await this.event(job, `⚠️ \`${next.title}\` is no longer available; trying the next one`);
          return this.save(job, "grabbing");
        }
      } else if (err instanceof ApiError && err.kind === "timeout") {
        // The app may well have sent it to the downloader; watch for it rather than grabbing twice.
        await this.event(job, `⏱️ ${a.name} was slow to confirm \`${next.title}\`; watching for the download`, "downloading");
        return;
      } else throw err;
    }
    await this.event(job, `⬇️ Attempt ${job.attempt}: grabbed \`${next.title}\``, "downloading");
  }

  private async attemptFailed(job: Job, reason: string, item?: QueueItem): Promise<void> {
    const a = this.adapter(job);
    if (item) await a.removeFromQueue(item.id, true).catch((err) => log.warn(`redownload #${job.id}: couldn't remove queue item: ${(err as Error).message}`));
    await this.event(job, `↩️ Attempt ${job.attempt} failed: ${reason}. Original untouched`, "grabbing");
    await this.startAttempt(job);
  }

  // ---- downloading ---------------------------------------------------------------
  private async checkDownload(job: Job): Promise<void> {
    const a = this.adapter(job);
    const t = job.target;
    const started = job.attemptStartedAt ?? job.createdAt;
    if (!job.current) return this.save(job, "grabbing");
    job.downloadId ??= await a.grabbedDownloadId(t, job.current.title, started - MINUTE);
    const items = await a.queue(t);
    const item = items.find((q) => (job.downloadId ? q.downloadId === job.downloadId : normRelease(q.title) === normRelease(job.current!.title)));
    if (item && !job.downloadId) job.downloadId = item.downloadId;
    this.mute(job.downloadId);

    // A better release imports on its own (as an upgrade): nothing to swap.
    if (await this.replaced(job)) return this.finish(job, "done", "The app imported it as an upgrade on its own.");

    if (!item) {
      if (job.downloadId && (await a.downloadFailed(t, job.downloadId))) return this.attemptFailed(job, "the download failed");
      if (Date.now() - started > LOST_DOWNLOAD_MS) return this.attemptFailed(job, "the download never showed up in the queue");
      return this.save(job);
    }

    const state = (item.state ?? "").toLowerCase();
    if (state === "failed" || state === "failedpending" || (item.status ?? "").toLowerCase() === "failed") {
      return this.attemptFailed(job, `the download failed${item.messages[0] ? ` (${item.messages[0]})` : ""}`, item);
    }
    if ((state === "importblocked" || state === "importpending") && item.sizeLeft <= 0) {
      if (state === "importpending" && item.messages.length === 0) return this.save(job); // importing right now
      if (readyToSwap(t.kind, item.messages)) {
        await this.event(job, "📦 Download finished; the old copy is the only thing in the way", "swapping");
        return this.swap(job);
      }
      return this.attemptFailed(job, `the app couldn't import it (${item.messages[0] ?? "unknown reason"})`, item);
    }
    if (Date.now() - started > this.d.cfg.redownload.attemptTimeoutHours * 3_600_000) {
      return this.attemptFailed(job, `it took longer than ${this.d.cfg.redownload.attemptTimeoutHours}h`, item);
    }
    // Still downloading: refresh the log entry every ~10 minutes.
    const pct = item.size > 0 ? Math.round(((item.size - item.sizeLeft) / item.size) * 100) : undefined;
    job.progress = pct;
    if (!job.progressLoggedAt || Date.now() - job.progressLoggedAt > 10 * MINUTE) {
      job.progressLoggedAt = Date.now();
      await this.updateLog(job);
    }
    this.save(job);
  }

  // ---- the swap -------------------------------------------------------------------
  private async swap(job: Job): Promise<void> {
    const a = this.adapter(job);
    const t = job.target;
    if (!(await a.recycleBin())) {
      // Never delete without a safety net. The download waits in the queue until this is fixed.
      if (!job.binWarned) {
        job.binWarned = true;
        job.outcome = `${a.name}'s recycling bin was switched off, so the swap is on hold. Set it again in ${a.name} → Settings → Media Management and it'll carry on by itself.`;
        await this.event(job, `🛑 ${a.name}'s recycling bin is no longer set, so I won't delete anything. Waiting for it`, "downloading");
        await this.alertAdmins(job);
      } else this.save(job, "downloading");
      return;
    }
    // Only ever delete files that are still the old ones (someone may have fixed it by hand meanwhile).
    const onDisk = new Set((await a.currentFiles(t)).map((f) => f.id));
    let deleteIds: number[];
    if (t.kind === "movie") {
      deleteIds = job.oldFiles.map((f) => f.id).filter((id) => onDisk.has(id));
    } else {
      // Only remove old files whose every episode/track is in the new download and importable.
      const preview = await a.importPreview(t, job.downloadId!);
      const covered = new Set(
        preview
          .filter((p) => p.coveredIds.length && p.rejections.some(isNotUpgradeMessage) && p.rejections.every((r) => isNotUpgradeMessage(r) || isHarmlessMessage(r)))
          .flatMap((p) => p.coveredIds),
      );
      deleteIds = job.oldFiles
        .filter((f) => onDisk.has(f.id) && (f.coveredIds ?? []).length > 0 && f.coveredIds!.every((id) => covered.has(id)))
        .map((f) => f.id);
      if (!deleteIds.length && !job.deletedIds?.length) {
        const item = (await a.queue(t)).find((q) => q.downloadId === job.downloadId);
        return this.attemptFailed(job, "the download doesn't contain the files being replaced", item);
      }
    }
    // Don't announce the swapped-in file as "new on Plex".
    this.d.notifier.suppress(t.dedupeKeys, SUPPRESS_ANNOUNCE_MS);
    job.binWarned = false;
    job.outcome = undefined;
    // Record the intent before deleting, so a crash mid-swap resumes correctly and is never refunded as "untouched".
    job.deletedIds = [...new Set([...(job.deletedIds ?? []), ...deleteIds])];
    job.changedFiles = true;
    job.swapStartedAt ??= Date.now();
    this.save(job);
    if (deleteIds.length) await a.deleteFiles(t, deleteIds);
    await a.refreshDownloads();
    await this.event(
      job,
      job.deletedIds.length
        ? `🗑️ Moved ${job.deletedIds.length} old file${job.deletedIds.length === 1 ? "" : "s"} to the recycling bin; importing the new copy`
        : "ℹ️ The old file was already gone; importing the new copy",
      "importing",
    );
  }

  private async checkImport(job: Job): Promise<void> {
    const a = this.adapter(job);
    if (await this.replaced(job)) return this.finish(job, "done");
    const since = Date.now() - (job.swapStartedAt ?? job.updatedAt);
    if (job.state === "importing" && since > IMPORT_STUCK_MS) {
      const bin = await a.recycleBin().catch(() => undefined);
      job.outcome =
        `The old copy is in ${a.name}'s recycling bin${bin ? ` (\`${bin}\`)` : ""}, but the new download hasn't imported. ` +
        `Finish it in ${a.name} → Activity → Queue → Manual Import, or restore the old file from the recycling bin.`;
      await this.event(job, "🆘 Import is stuck. An admin needs to finish it", "needs_admin");
      await this.alertAdmins(job);
      return;
    }
    // Nudge the app every few minutes in case it hasn't re-checked yet.
    if (Math.floor(since / MINUTE) % 3 === 0) await a.refreshDownloads().catch(() => undefined);
    this.save(job);
  }

  /** True once every replaced episode/track/movie has a file that isn't one of the old ones. */
  private async replaced(job: Job): Promise<boolean> {
    const files = await this.adapter(job).currentFiles(job.target);
    const old = new Set(job.oldFiles.map((f) => f.id));
    if (job.target.kind === "movie") return files.some((f) => !old.has(f.id));
    const relevant = job.oldFiles.filter((f) => !job.deletedIds?.length || job.deletedIds.includes(f.id)).flatMap((f) => f.coveredIds ?? []);
    if (!relevant.length) return false;
    return relevant.every((id) => files.some((f) => !old.has(f.id) && (f.coveredIds ?? []).includes(id)));
  }

  // ---- endings ----------------------------------------------------------------------
  async finish(
    job: Job,
    state: Extract<JobState, "done" | "failed" | "cancelled" | "denied">,
    outcome?: string,
    by?: string,
    opts: { blocklist?: boolean } = {},
  ): Promise<void> {
    if (state === "done" && opts.blocklist !== false) {
      // Blocklist the release that was replaced, so the app never grabs it again.
      const a = this.adapter(job);
      let blocked = 0;
      for (const g of job.oldGrabs.filter((x) => x.blocklist !== false)) {
        this.mute(g.downloadId, g.title);
        try {
          await a.markFailed(g.historyId);
          blocked++;
        } catch (err) {
          log.warn(`redownload #${job.id}: couldn't blocklist "${g.title}": ${(err as Error).message}`);
        }
      }
      if (!job.oldGrabs.some((x) => x.blocklist !== false)) job.events.push({ at: Date.now(), text: "ℹ️ The old copy had no download history, so there was nothing to blocklist" });
      else if (blocked) job.events.push({ at: Date.now(), text: `🚫 Blocklisted the old release${blocked === 1 ? "" : "s"}` });
    }
    job.finishedAt = Date.now();
    if (outcome) job.outcome = outcome;
    if (by) job.endedBy = by;
    await this.event(job, { done: by ? "✅ Resolved" : "✅ Replaced", failed: "❌ Gave up", cancelled: `🛑 Cancelled${by ? ` by <@${by}>` : ""}`, denied: `🚫 Denied${by ? ` by <@${by}>` : ""}` }[state], state);
    await this.notifyRequester(job);
  }

  cancel(id: number, by: string): Promise<string> {
    return this.exclusive(id, (job) => this.cancelLocked(job, by)).then((r) => r ?? "I can't find that redownload any more.");
  }

  deny(id: number, by: string, reason?: string): Promise<string> {
    return this.exclusive(id, async (job) => {
      if (job.state !== "awaiting_approval") return "That one isn't waiting for approval any more.";
      await this.finish(job, "denied", reason, by);
      return "Denied. They've been told, and it didn't use up one of their redownloads.";
    }).then((r) => r ?? "I can't find that redownload any more.");
  }

  private async cancelLocked(job: Job, by: string): Promise<string> {
    if (!["awaiting_approval", "grabbing", "downloading"].includes(job.state)) {
      return "It's already past the point where it can be cancelled (the files are being swapped or it's finished).";
    }
    if (job.state === "downloading") {
      const a = this.adapter(job);
      const item = (await a.queue(job.target)).find((q) => (job.downloadId ? q.downloadId === job.downloadId : normRelease(q.title) === normRelease(job.current?.title)));
      if (item) await a.removeFromQueue(item.id, false);
    }
    await this.finish(job, "cancelled", "Stopped before anything was changed. The original is untouched.", by);
    return "Cancelled. Nothing was changed.";
  }

  /** An admin finished a stuck swap by hand (or restored the old file). */
  resolve(id: number, by: string): Promise<string> {
    return this.exclusive(id, (job) => this.resolveLocked(job, by)).then((r) => r ?? "I can't find that redownload any more.");
  }

  private async resolveLocked(job: Job, by: string): Promise<string> {
    if (job.state !== "needs_admin" && job.state !== "importing") return "That one doesn't need an admin.";
    const fixed = await this.replaced(job).catch(() => false);
    await this.finish(job, "done", fixed ? `Finished by <@${by}>.` : `Marked resolved by <@${by}>.`, by, { blocklist: fixed });
    return "Marked resolved.";
  }

  async approve(id: number, by: string): Promise<string> {
    const r = await this.exclusive(id, async (job) => {
      if (job.state !== "awaiting_approval") return "That one isn't waiting for approval any more.";
      job.approvedBy = by;
      await this.event(job, `✅ Approved by <@${by}>`, "grabbing");
      return "Approved. It's on its way.";
    });
    if (r?.startsWith("Approved")) await this.tick(id);
    return r ?? "I can't find that redownload any more.";
  }

  // ---- logging & messages --------------------------------------------------------------
  private save(job: Job, state?: JobState) {
    if (state) job.state = state;
    this.d.rstore.saveJob(job);
  }

  private async event(job: Job, text: string, state?: JobState) {
    const last = job.events.at(-1);
    if (last?.text === text) last.at = Date.now(); // same thing again: just refresh its time
    else job.events.push({ at: Date.now(), text });
    if (job.events.length > 60) job.events.splice(1, job.events.length - 60);
    this.save(job, state);
    log.info(`redownload #${job.id} (${job.target.label}): ${text.replace(/<@\d+>/g, "")}`);
    await this.updateLog(job);
  }

  private logChannelId(): string | undefined {
    const c = this.d.cfg.channels;
    return c.redownloadLog ?? c.admin; // never the public status channel: the log has ban buttons and names
  }

  async updateLog(job: Job): Promise<void> {
    const payload = { embeds: [logEmbed(job)], components: logButtons(job), allowedMentions: { parse: [] as [] } };
    try {
      if (job.logChannelId && job.logMessageId) {
        const ch = await this.d.client.channels.fetch(job.logChannelId).catch(() => null);
        if (ch && "messages" in ch) {
          const msg = await ch.messages.fetch(job.logMessageId).catch(() => null);
          if (msg) {
            await msg.edit(payload);
            return;
          }
        }
      }
      const id = this.logChannelId();
      if (!id) return;
      const ch = await this.d.client.channels.fetch(id).catch(() => null);
      if (!ch?.isSendable()) return;
      const msg = await (ch as SendableChannels).send(payload);
      job.logChannelId = msg.channelId;
      job.logMessageId = msg.id;
      this.d.rstore.saveJob(job);
    } catch (err) {
      log.warn(`redownload #${job.id}: couldn't update the log entry: ${(err as Error).message}`);
    }
  }

  private async alertAdmins(job: Job) {
    const id = this.logChannelId();
    if (!id) return;
    const ch = await this.d.client.channels.fetch(id).catch(() => null);
    const role = this.d.cfg.adminRoleId;
    if (ch?.isSendable()) {
      await (ch as SendableChannels)
        .send({ content: `${role ? `<@&${role}> ` : ""}🆘 Redownload #${job.id} (**${job.target.label}**) needs a hand: ${job.outcome}`, allowedMentions: { roles: role ? [role] : [] } })
        .catch(() => undefined);
    }
  }

  private async notifyRequester(job: Job) {
    const text: Record<string, string> = {
      done: `✅ **${job.target.label}** has been replaced with a fresh copy. Give Plex a minute to notice, then try it again.`,
      failed: `❌ I couldn't find a working replacement for **${job.target.label}**${job.outcome ? ` (${job.outcome})` : ""}. Your original copy is untouched, and this didn't use up one of your redownloads. If it's still broken, use \`/report\` so an admin can take a look.`,
      cancelled: `🛑 Your redownload of **${job.target.label}** was cancelled before anything changed. It didn't use up one of your redownloads.`,
      denied: `🚫 Your redownload of **${job.target.label}** wasn't approved${job.outcome ? ` (${job.outcome})` : ""}. It didn't use up one of your redownloads.`,
    };
    const handFixed = job.state === "done" && /^Marked resolved/.test(job.outcome ?? "");
    const msg = handFixed ? `🧰 An admin finished up your redownload of **${job.target.label}**. If it's still not right, use \`/report\`.` : text[job.state];
    if (!msg || job.endedBy === job.discordUserId) return;
    const sent = await dm(this.d.client, job.discordUserId, msg);
    if (!sent && this.d.cfg.channels.notify) {
      const ch = await this.d.client.channels.fetch(this.d.cfg.channels.notify).catch(() => null);
      if (ch?.isSendable()) {
        const short = job.state === "done" ? `✅ <@${job.discordUserId}> **${job.target.label}** has been replaced.` : `<@${job.discordUserId}> your redownload of **${job.target.label}** ended: ${job.state}.`;
        await (ch as SendableChannels).send({ content: short, allowedMentions: { users: [job.discordUserId] } }).catch(() => undefined);
      }
    }
  }
}
