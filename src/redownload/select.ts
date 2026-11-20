/**
 * Choosing replacement releases, and reading the apps' import messages.
 * Pure functions, so the safety rules are easy to test.
 */
import { normRelease } from "./arr.js";
import type { Release, TargetKind } from "./types.js";

/**
 * When a file already exists, the app rejects every same-or-lower release with
 * a reason starting "Existing file…". Those are exactly the releases we may
 * use as replacements. Any other reason (blocklisted, not wanted by the
 * quality profile, already in the queue, too small…) disqualifies a release.
 */
export const REPLACEABLE_REJECTION = /^existing files?\b/i;

/** Import refused only because a file is already there ("Not an upgrade…"): safe to swap. */
export function isNotUpgradeMessage(m: string): boolean {
  return /\bnot an? (?:[a-z ]+ )?upgrade\b/i.test(m);
}

/** Import messages that don't matter (extras inside a release). */
export function isHarmlessMessage(m: string): boolean {
  return /\bsample\b/i.test(m);
}

/**
 * Is a finished download ready to swap in? Movies/episodes: every message must
 * be "not an upgrade" (or harmless). Seasons/albums: at least one file is
 * blocked only by the old copy; the import preview then decides exactly which
 * old files get replaced, so partial packs never delete anything uncovered.
 */
export function readyToSwap(kind: TargetKind, messages: string[]): boolean {
  const notUpgrade = messages.filter(isNotUpgradeMessage);
  if (!notUpgrade.length) return false;
  if (kind === "season" || kind === "album") return true;
  return messages.every((m) => isNotUpgradeMessage(m) || isHarmlessMessage(m));
}

const MIN_SIZE: Record<TargetKind, number> = {
  movie: 300 * 1024 ** 2,
  episode: 50 * 1024 ** 2,
  season: 200 * 1024 ** 2,
  album: 15 * 1024 ** 2,
};

export interface PickOptions {
  kind: TargetKind;
  /** Releases to never pick again: the one(s) on disk and ones already tried. */
  excludeTitles: string[];
  /** Total size of the files being replaced. */
  currentSize: number;
  limit?: number;
}

/** Why a release was skipped (shown to admins in the log when nothing qualifies). */
export function disqualify(r: Release, o: PickOptions): string | undefined {
  const bad = r.rejections.filter((x) => !REPLACEABLE_REJECTION.test(x));
  if (bad.length) return bad[0];
  if (o.excludeTitles.some((t) => normRelease(t) === normRelease(r.title))) return "same release as before";
  if (r.protocol === "torrent" && r.seeders !== undefined && r.seeders < 1) return "no seeders";
  if (o.kind === "season" && !r.fullSeason) return "not a full-season pack";
  if (o.kind === "episode" && r.fullSeason) return "season pack (only one episode was asked for)";
  // Guards against samples, fakes and mislabelled junk.
  const floor = Math.max(MIN_SIZE[o.kind], o.currentSize * 0.25);
  if (!r.size || r.size < floor) return "suspiciously small";
  return undefined;
}

export function pickCandidates(releases: Release[], o: PickOptions): Release[] {
  const ok = releases.filter((r) => !disqualify(r, o));
  const health = (r: Release) => (r.protocol === "torrent" ? (r.seeders ?? 0) : 1000); // usenet has no seeders; treat as healthy
  ok.sort(
    (a, b) =>
      b.qualityWeight - a.qualityWeight ||
      b.customFormatScore - a.customFormatScore ||
      Math.min(health(b), 50) - Math.min(health(a), 50) || // beyond ~50 seeders it doesn't matter
      Math.abs(a.size - o.currentSize) - Math.abs(b.size - o.currentSize),
  );
  // One entry per release name (several indexers often list the same one).
  const seen = new Set<string>();
  return ok.filter((r) => (seen.has(normRelease(r.title)) ? false : (seen.add(normRelease(r.title)), true))).slice(0, o.limit ?? 10);
}

export function fmtSize(bytes: number): string {
  if (!bytes) return "?";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function releaseSummary(r: Release): string {
  const health = r.protocol === "torrent" ? (r.seeders !== undefined ? `${r.seeders} seeders` : "torrent") : "usenet";
  return `${r.quality} · ${fmtSize(r.size)} · ${health}${r.indexer ? ` · ${r.indexer}` : ""}`;
}
