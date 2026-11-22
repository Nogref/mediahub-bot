/** Missing-content jobs: one per season (or movie) a member asked to fill in. */
import type { Store } from "../core/db.js";

export type MissingState = "awaiting_approval" | "searching" | "downloading" | "done" | "partial" | "not_found" | "failed" | "cancelled" | "denied";
export const MISSING_ACTIVE: MissingState[] = ["awaiting_approval", "searching", "downloading"];

/** Per episode (or the one movie). */
export type ItemState = "searching" | "downloading" | "imported" | "not_found" | "failed" | "stuck";

export interface MissingItem {
  /** Episode id (Sonarr) or movie id (Radarr). */
  id: number;
  /** "E04 · Pilot" or the movie title. */
  label: string;
  state: ItemState;
  downloadId?: string;
  grabbedAt?: number;
  lastSeenAt?: number;
  progress?: number;
  eta?: string;
  queueStatus?: string;
  blockedSince?: number;
  /** The app's own reason when something's wrong (admins see it, members don't). */
  message?: string;
}

export interface MissingTarget {
  kind: "episodes" | "movie";
  app: "sonarr" | "radarr";
  /** missing:sonarr:<seriesId>:<season> or missing:radarr:<movieId> */
  key: string;
  label: string;
  posterUrl?: string;
  seriesId?: number;
  seasonNumber?: number;
  movieId?: number;
  /** Nothing in this season is downloaded: try a season pack first. */
  wholeSeason?: boolean;
}

export interface MissingJob {
  id: number;
  discordUserId: string;
  plexUsername?: string;
  target: MissingTarget;
  items: MissingItem[];
  state: MissingState;
  phase?: "season" | "episodes" | "movie";
  commandId?: number;
  commandStartedAt?: number;
  commandFinishedAt?: number;
  searchStartedAt?: number;
  logChannelId?: string;
  logMessageId?: string;
  trackerChannelId?: string;
  trackerMessageId?: string;
  events: Array<{ at: number; text: string }>;
  outcome?: string;
  bypassLimits: boolean;
  approvedBy?: string;
  endedBy?: string;
  errorCount?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export class MissingStore {
  constructor(private readonly store: Store) {
    store.sql.exec(`
      CREATE TABLE IF NOT EXISTS missing_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id TEXT NOT NULL,
        target_key TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS missing_jobs_state ON missing_jobs(state);
      CREATE INDEX IF NOT EXISTS missing_jobs_key ON missing_jobs(target_key, finished_at);
    `);
  }

  private row(r: { id: number; data: string } | undefined): MissingJob | undefined {
    return r ? { ...JSON.parse(r.data), id: r.id } : undefined;
  }

  create(j: Omit<MissingJob, "id" | "createdAt" | "updatedAt">): MissingJob {
    const now = Date.now();
    const full = { ...j, createdAt: now, updatedAt: now };
    const r = this.store.sql
      .prepare("INSERT INTO missing_jobs (discord_user_id, target_key, state, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(j.discordUserId, j.target.key, j.state, JSON.stringify(full), now);
    return { ...full, id: Number(r.lastInsertRowid) };
  }

  save(j: MissingJob): void {
    j.updatedAt = Date.now();
    const { id, ...rest } = j;
    this.store.sql.prepare("UPDATE missing_jobs SET state = ?, data = ?, finished_at = ? WHERE id = ?").run(j.state, JSON.stringify(rest), j.finishedAt ?? null, id);
  }

  job(id: number): MissingJob | undefined {
    return this.row(this.store.sql.prepare("SELECT id, data FROM missing_jobs WHERE id = ?").get(id) as { id: number; data: string } | undefined);
  }

  active(): MissingJob[] {
    const marks = MISSING_ACTIVE.map(() => "?").join(", ");
    return (this.store.sql.prepare(`SELECT id, data FROM missing_jobs WHERE state IN (${marks}) ORDER BY id`).all(...MISSING_ACTIVE) as Array<{ id: number; data: string }>).map(
      (r) => this.row(r)!,
    );
  }

  recent(limit = 10, userId?: string): MissingJob[] {
    const rows = userId
      ? this.store.sql.prepare("SELECT id, data FROM missing_jobs WHERE discord_user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit)
      : this.store.sql.prepare("SELECT id, data FROM missing_jobs ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as Array<{ id: number; data: string }>).map((r) => this.row(r)!);
  }

  /** The last job for this title that ended without finding everything (for the retry cooldown). */
  lastUnsuccessful(key: string, since: number): MissingJob | undefined {
    const r = this.store.sql
      .prepare("SELECT id, data FROM missing_jobs WHERE target_key = ? AND state IN ('not_found', 'failed') AND finished_at > ? ORDER BY finished_at DESC LIMIT 1")
      .get(key, since) as { id: number; data: string } | undefined;
    return this.row(r);
  }
}
