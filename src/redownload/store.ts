/**
 * Tables for Plex links and redownload jobs. Jobs are a persisted state
 * machine, so a bot restart picks up exactly where it left off.
 */
import type Database from "better-sqlite3";
import type { Store } from "../core/db.js";
import type { Release, Target } from "./types.js";

export interface PlexLink {
  discordUserId: string;
  plexUserId: number;
  plexUsername: string;
  hasAccess: boolean;
  linkedAt: number;
  verifiedAt: number;
}

export type JobState =
  | "awaiting_approval" // approve-first mode: waiting for an admin
  | "grabbing" //          about to send the chosen release to the downloader
  | "downloading" //       queued/downloading; the old file is still in place
  | "swapping" //          download finished; old file being removed
  | "importing" //         old file removed; waiting for the app to import the new one
  | "needs_admin" //       stuck in a state only an admin can fix (logged loudly)
  | "done"
  | "failed"
  | "cancelled"
  | "denied";

export const ACTIVE_STATES: JobState[] = ["awaiting_approval", "grabbing", "downloading", "swapping", "importing", "needs_admin"];

export interface Job {
  id: number;
  discordUserId: string;
  plexUsername?: string;
  target: Target;
  problem: string;
  details: string;
  state: JobState;
  attempt: number;
  candidates: Release[]; // ranked; index = attempt order
  tried: string[]; //       release titles already attempted
  current?: Release; //     release being downloaded now
  oldFiles: Array<{ id: number; quality: string; size: number; releaseTitle?: string; coveredIds?: number[] }>;
  /** Grab history behind the old files, blocklisted once the replacement is in. */
  oldGrabs: Array<{ historyId: number; title: string; downloadId?: string; blocklist?: boolean }>;
  errorCount?: number;
  /** Old file ids actually removed during the swap. */
  deletedIds?: number[];
  progress?: number;
  progressLoggedAt?: number;
  binWarned?: boolean;
  approvedBy?: string;
  endedBy?: string;
  downloadId?: string;
  attemptStartedAt?: number;
  swapStartedAt?: number;
  logChannelId?: string;
  logMessageId?: string;
  events: Array<{ at: number; text: string }>;
  outcome?: string;
  changedFiles: boolean; // true once an old file was deleted (used for refunds)
  bypassLimits: boolean;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

type Row = Record<string, unknown>;

export class RedownloadStore {
  private db: Database.Database;

  constructor(store: Store) {
    this.db = store.sql;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plex_links (
        discord_user_id TEXT PRIMARY KEY,
        plex_user_id    INTEGER NOT NULL,
        plex_username   TEXT NOT NULL,
        has_access      INTEGER NOT NULL,
        linked_at       INTEGER NOT NULL,
        verified_at     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS redownload_jobs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id TEXT NOT NULL,
        target_key      TEXT NOT NULL,
        state           TEXT NOT NULL,
        data            TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        finished_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS redownload_user ON redownload_jobs(discord_user_id, created_at);
      CREATE INDEX IF NOT EXISTS redownload_target ON redownload_jobs(target_key, finished_at);
      CREATE INDEX IF NOT EXISTS redownload_state ON redownload_jobs(state);
    `);
  }

  // ---- Plex links -------------------------------------------------------------
  link(discordUserId: string): PlexLink | undefined {
    const r = this.db.prepare("SELECT * FROM plex_links WHERE discord_user_id = ?").get(discordUserId) as Row | undefined;
    return r
      ? {
          discordUserId,
          plexUserId: r.plex_user_id as number,
          plexUsername: r.plex_username as string,
          hasAccess: r.has_access === 1,
          linkedAt: r.linked_at as number,
          verifiedAt: r.verified_at as number,
        }
      : undefined;
  }
  saveLink(l: PlexLink) {
    this.db
      .prepare(
        `INSERT INTO plex_links(discord_user_id, plex_user_id, plex_username, has_access, linked_at, verified_at)
         VALUES(@discordUserId, @plexUserId, @plexUsername, @hasAccess, @linkedAt, @verifiedAt)
         ON CONFLICT(discord_user_id) DO UPDATE SET plex_user_id = excluded.plex_user_id, plex_username = excluded.plex_username,
           has_access = excluded.has_access, linked_at = excluded.linked_at, verified_at = excluded.verified_at`,
      )
      .run({ ...l, hasAccess: l.hasAccess ? 1 : 0 });
  }
  setVerified(discordUserId: string, hasAccess: boolean, at = Date.now()) {
    this.db.prepare("UPDATE plex_links SET has_access = ?, verified_at = ? WHERE discord_user_id = ?").run(hasAccess ? 1 : 0, at, discordUserId);
  }
  deleteLink(discordUserId: string) {
    this.db.prepare("DELETE FROM plex_links WHERE discord_user_id = ?").run(discordUserId);
  }
  /** Another Discord member already linked to this Plex account? */
  linkByPlexId(plexUserId: number): PlexLink | undefined {
    const r = this.db.prepare("SELECT discord_user_id FROM plex_links WHERE plex_user_id = ?").get(plexUserId) as Row | undefined;
    return r ? this.link(r.discord_user_id as string) : undefined;
  }
  links(): PlexLink[] {
    return (this.db.prepare("SELECT discord_user_id FROM plex_links ORDER BY linked_at").all() as Row[]).map((r) => this.link(r.discord_user_id as string)!);
  }

  // ---- jobs ---------------------------------------------------------------------
  private toJob(r: Row): Job {
    return { ...(JSON.parse(r.data as string) as Job), id: r.id as number, state: r.state as JobState };
  }
  createJob(j: Omit<Job, "id" | "createdAt" | "updatedAt" | "events" | "attempt" | "tried" | "changedFiles"> & { events?: Job["events"] }): Job {
    const now = Date.now();
    const job: Omit<Job, "id"> = { attempt: 0, tried: [], changedFiles: false, events: [], ...j, createdAt: now, updatedAt: now };
    const info = this.db
      .prepare("INSERT INTO redownload_jobs(discord_user_id, target_key, state, data, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(j.discordUserId, j.target.key, j.state, JSON.stringify(job), now);
    return { ...job, id: Number(info.lastInsertRowid) };
  }
  saveJob(j: Job) {
    j.updatedAt = Date.now();
    this.db
      .prepare("UPDATE redownload_jobs SET state = ?, data = ?, finished_at = ? WHERE id = ?")
      .run(j.state, JSON.stringify(j), j.finishedAt ?? null, j.id);
  }
  job(id: number): Job | undefined {
    const r = this.db.prepare("SELECT * FROM redownload_jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toJob(r) : undefined;
  }
  activeJobs(): Job[] {
    const q = `SELECT * FROM redownload_jobs WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")}) ORDER BY id`;
    return (this.db.prepare(q).all(...ACTIVE_STATES) as Row[]).map((r) => this.toJob(r));
  }
  jobsForUserSince(discordUserId: string, since: number): Job[] {
    return (this.db.prepare("SELECT * FROM redownload_jobs WHERE discord_user_id = ? AND created_at >= ? ORDER BY id DESC").all(discordUserId, since) as Row[]).map((r) =>
      this.toJob(r),
    );
  }
  /** Finished, successful replacements that overlap this target (same title/season/episode) since `since`. */
  recentlyReplaced(targetKey: string, since: number): Job | undefined {
    const rows = this.db.prepare("SELECT * FROM redownload_jobs WHERE state = 'done' AND finished_at >= ? ORDER BY finished_at DESC").all(since) as Row[];
    return rows.map((r) => this.toJob(r)).find((j) => keysOverlap(j.target.key, targetKey));
  }
  recentJobs(limit = 20, discordUserId?: string): Job[] {
    const rows = discordUserId
      ? this.db.prepare("SELECT * FROM redownload_jobs WHERE discord_user_id = ? ORDER BY id DESC LIMIT ?").all(discordUserId, limit)
      : this.db.prepare("SELECT * FROM redownload_jobs ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as Row[]).map((r) => this.toJob(r));
  }
}

/**
 * Keys are hierarchical ("sonarr:12:s3" covers "sonarr:12:s3:e5"), so a season
 * and one of its episodes count as the same title for locks and cooldowns.
 */
export function keysOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}
