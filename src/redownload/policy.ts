/**
 * Who may redownload what, right now. Every check returns a plain-English
 * reason when it says no. Admins bypass limits, cooldowns, bans and pauses,
 * but never the safety checks (recycle bin, one job per title).
 */
import type { Store } from "../core/db.js";
import { ACTIVE_STATES, keysOverlap, type Job, type RedownloadStore } from "./store.js";
import type { Target } from "./types.js";

export interface PolicySettings {
  paused?: { by: string; reason?: string; at: number };
  approvals: boolean;
  banned: Record<string, { by: string; reason?: string; at: number }>;
}

const KEY = "redownload.settings";

export function loadSettings(store: Store): PolicySettings {
  return { approvals: false, banned: {}, ...(store.kvGet<PolicySettings>(KEY) ?? {}) };
}

export function saveSettings(store: Store, s: PolicySettings): void {
  store.kvSet(KEY, s);
}

/** A job uses up slots unless it ended without changing anything (failed, cancelled, denied). */
export function countsTowardQuota(j: Job): boolean {
  return ACTIVE_STATES.includes(j.state) || j.state === "done" || j.changedFiles;
}

export interface Limits {
  dailyLimit: number;
  titleCooldownHours: number;
  maxActive: number;
}

export function quotaUsed(rs: RedownloadStore, userId: string, now = Date.now()): { used: number; nextFreeAt?: number } {
  const jobs = rs.jobsForUserSince(userId, now - 86_400_000).filter((j) => !j.bypassLimits && countsTowardQuota(j));
  const used = jobs.reduce((a, j) => a + j.target.weight, 0);
  const oldest = jobs.map((j) => j.createdAt).sort((a, b) => a - b)[0];
  return { used, nextFreeAt: oldest ? oldest + 86_400_000 : undefined };
}

/** Checks that apply before searching (cheap, no API calls). */
export function precheck(
  rs: RedownloadStore,
  settings: PolicySettings,
  limits: Limits,
  who: { id: string; admin: boolean },
  target: Target,
  now = Date.now(),
): string | null {
  if (!who.admin) {
    if (settings.paused) return `⏸️ Redownloads are paused by an admin${settings.paused.reason ? `: ${settings.paused.reason}` : ""}. Try again later.`;
    const ban = settings.banned[who.id];
    if (ban) return `🚫 You can't use redownloads right now${ban.reason ? ` (${ban.reason})` : ""}. Ask an admin if you think that's a mistake.`;
  }

  const active = rs.activeJobs();
  const clash = active.find((j) => keysOverlap(j.target.key, target.key));
  if (clash) return `⏳ **${clash.target.label}** is already being replaced (redownload #${clash.id}). Check back once that's finished.`;
  // Jobs waiting on a human (approval, a stuck import) don't hold up everyone else.
  if (active.filter((j) => j.state !== "awaiting_approval" && j.state !== "needs_admin").length >= limits.maxActive && !who.admin) {
    return `🚦 ${limits.maxActive} redownloads are already running. Please try again in a little while.`;
  }

  if (!who.admin) {
    if (limits.titleCooldownHours > 0) {
      const recent = rs.recentlyReplaced(target.key, now - limits.titleCooldownHours * 3_600_000);
      if (recent) {
        const until = Math.floor((recent.finishedAt! + limits.titleCooldownHours * 3_600_000) / 1000);
        return `🧊 **${recent.target.label}** was replaced recently, so it can't be redone until <t:${until}:R>. If the new copy is also broken, use \`/report\` so an admin can look.`;
      }
    }
    const { used, nextFreeAt } = quotaUsed(rs, who.id, now);
    if (used + target.weight > limits.dailyLimit) {
      const what = target.weight > 1 ? `A whole season uses ${target.weight} of your ${limits.dailyLimit} daily redownloads` : `You've used your ${limits.dailyLimit} redownloads for the last 24 hours`;
      return `🔢 ${what} (${used} used). ${nextFreeAt ? `A slot frees up <t:${Math.floor(nextFreeAt / 1000)}:R>.` : ""}`;
    }
  }
  return null;
}
