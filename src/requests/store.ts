/** Live tracker state for each request (the request itself lives in the `requests` table). */
import type { Store } from "../core/db.js";

export type RqState = "approval" | "searching" | "downloading" | "not_out" | "stalled" | "done" | "declined" | "expired";
export const RQ_FINAL: RqState[] = ["done", "declined", "expired"];

export interface SeasonProgress {
  season: number;
  aired: number;
  onPlex: number;
  downloading: number;
  upcoming: number;
  /** First air date of a season that hasn't started. */
  startsAt?: number;
  /** Average progress of what's downloading in this season. */
  progress?: number;
  /** Coarse status when only Seerr is available: "available" | "partial" | "processing". */
  coarse?: string;
}

export interface RqTracker {
  requestId: number;
  state: RqState;
  dmChannelId?: string;
  dmMessageId?: string;
  /** The line above the card in the DM. */
  intro?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Last time anything moved (a download, a new file): the 24h "stalled" clock runs from here. */
  lastActivityAt: number;
  stalledAt?: number;
  progress?: number;
  eta?: string;
  queueStatus?: string;
  releaseAt?: number;
  /** When it stopped being "not out yet". */
  outAt?: number;
  seasons?: SeasonProgress[];
  /** Requested seasons (from the request), when it wasn't the whole show. */
  requestedSeasons?: number[];
  tracks?: { have: number; total: number };
  onPlex?: number;
  nextCheckAt?: number;
  errorCount?: number;
}

export class RequestTrackerStore {
  constructor(private readonly store: Store) {
    store.sql.exec(`
      CREATE TABLE IF NOT EXISTS request_trackers (
        request_id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  get(requestId: number): RqTracker | undefined {
    const r = this.store.sql.prepare("SELECT data FROM request_trackers WHERE request_id = ?").get(requestId) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }

  save(t: RqTracker): void {
    t.updatedAt = Date.now();
    this.store.sql
      .prepare("INSERT INTO request_trackers (request_id, state, data) VALUES (?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET state = excluded.state, data = excluded.data")
      .run(t.requestId, t.state, JSON.stringify(t));
  }

  active(): RqTracker[] {
    const marks = RQ_FINAL.map(() => "?").join(", ");
    return (this.store.sql.prepare(`SELECT data FROM request_trackers WHERE state NOT IN (${marks})`).all(...RQ_FINAL) as Array<{ data: string }>).map((r) => JSON.parse(r.data));
  }
}
