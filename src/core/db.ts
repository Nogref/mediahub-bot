/**
 * Small-state store on the mounted /data volume.
 *
 * Holds only what the bot itself needs to remember: the status-board message,
 * who asked for what (so we can @ them when it lands), invite nicknames and the
 * last known up/down state per service. No user management lives here.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type RequestKind = "movie" | "tv" | "album";
export type RequestTarget = "seerr" | "lidarr" | "aurral";

export interface TrackedRequest {
  id: number;
  discordUserId: string;
  kind: RequestKind;
  target: RequestTarget;
  title: string;
  year?: number;
  artistName?: string;
  tmdbId?: number;
  tvdbId?: number;
  seerrRequestId?: number;
  mbAlbumId?: string;
  mbArtistId?: string;
  lidarrAlbumId?: number;
  aurralAlbumId?: string;
  posterUrl?: string;
  status: "pending" | "notified" | "expired";
  createdAt: number;
}

export type NewRequest = Omit<TrackedRequest, "id" | "status" | "createdAt">;

/** Identifiers carried by an inbound "this is now available" event. */
export interface MatchKeys {
  kind: RequestKind;
  tmdbId?: number;
  tvdbId?: number;
  seerrRequestId?: number;
  mbAlbumId?: string;
  lidarrAlbumId?: number;
  aurralAlbumId?: string;
  artistName?: string;
  title?: string;
}

export interface StoredInvite {
  name: string;
  wizarrId: number;
  code: string;
  createdBy: string;
  createdAt: number;
  /** Discord user the link was DM'd to, if any. */
  forUserId?: string;
}

export interface StoredReport {
  issueId: number;
  discordUserId: string;
  title: string;
  createdAt: number;
}

/** Lowercases and strips punctuation/edition noise so "Abbey Road (Remastered)" matches "abbey road". */
export function normalizeTitle(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\((?:[^)]*(?:remaster|deluxe|edition|expanded|anniversary)[^)]*)\)|\[[^\]]*\]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type Row = Record<string, unknown>;

function toRequest(r: Row): TrackedRequest {
  const opt = <T>(v: unknown) => (v === null || v === undefined ? undefined : (v as T));
  return {
    id: r.id as number,
    discordUserId: r.discord_user_id as string,
    kind: r.kind as RequestKind,
    target: r.target as RequestTarget,
    title: r.title as string,
    year: opt<number>(r.year),
    artistName: opt<string>(r.artist_name),
    tmdbId: opt<number>(r.tmdb_id),
    tvdbId: opt<number>(r.tvdb_id),
    seerrRequestId: opt<number>(r.seerr_request_id),
    mbAlbumId: opt<string>(r.mb_album_id),
    mbArtistId: opt<string>(r.mb_artist_id),
    lidarrAlbumId: opt<number>(r.lidarr_album_id),
    aurralAlbumId: opt<string>(r.aurral_album_id),
    posterUrl: opt<string>(r.poster_url),
    status: r.status as TrackedRequest["status"],
    createdAt: r.created_at as number,
  };
}

export class Store {
  private db: Database.Database;

  constructor(dataDir: string) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.accessSync(dataDir, fs.constants.W_OK);
    } catch (err) {
      throw new Error(
        `DATA_DIR ${dataDir} isn't writable by uid ${process.getuid?.() ?? "?"} (${(err as Error).message}). ` +
          `On Unraid: chown -R 99:100 /mnt/user/appdata/mediahub-bot`,
      );
    }
    this.db = new Database(path.join(dataDir, "bot.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id  TEXT NOT NULL,
        kind             TEXT NOT NULL,
        target           TEXT NOT NULL,
        title            TEXT NOT NULL,
        year             INTEGER,
        artist_name      TEXT,
        tmdb_id          INTEGER,
        tvdb_id          INTEGER,
        seerr_request_id INTEGER,
        mb_album_id      TEXT,
        mb_artist_id     TEXT,
        lidarr_album_id  INTEGER,
        aurral_album_id  TEXT,
        poster_url       TEXT,
        norm_title       TEXT,
        norm_artist      TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        created_at       INTEGER NOT NULL,
        notified_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS requests_pending ON requests(status, kind);
      CREATE TABLE IF NOT EXISTS invites (
        name       TEXT PRIMARY KEY COLLATE NOCASE,
        wizarr_id  INTEGER NOT NULL,
        code       TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        issue_id        INTEGER PRIMARY KEY,
        discord_user_id TEXT NOT NULL,
        title           TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open',
        created_at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aurral_accounts (
        discord_user_id TEXT PRIMARY KEY,
        aurral_user_id  INTEGER NOT NULL,
        username        TEXT NOT NULL,
        created_by      TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_state (
        service    TEXT PRIMARY KEY,
        up         INTEGER NOT NULL,
        changed_at INTEGER NOT NULL
      );
    `);
    // Columns added after the first release.
    const inviteCols = (this.db.prepare("PRAGMA table_info(invites)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!inviteCols.includes("for_user_id")) this.db.exec("ALTER TABLE invites ADD COLUMN for_user_id TEXT");
  }

  close() {
    this.db.close();
  }

  /** Raw handle for feature-owned tables (see src/redownload/store.ts). */
  get sql(): Database.Database {
    return this.db;
  }

  // ---- key/value -----------------------------------------------------------
  kvGet<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  kvSet(key: string, value: unknown) {
    this.db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
  kvDelete(key: string) {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  // ---- request history -------------------------------------------------------
  /** Records a request; a user re-requesting the same pending item doesn't create duplicates. */
  addRequest(r: NewRequest): number {
    const existing = this.findPending({ ...r, kind: r.kind }).find((p) => p.discordUserId === r.discordUserId);
    if (existing) return existing.id;
    const info = this.db
      .prepare(
        `INSERT INTO requests (discord_user_id, kind, target, title, year, artist_name, tmdb_id, tvdb_id,
           seerr_request_id, mb_album_id, mb_artist_id, lidarr_album_id, aurral_album_id, poster_url,
           norm_title, norm_artist, status, created_at)
         VALUES (@discordUserId, @kind, @target, @title, @year, @artistName, @tmdbId, @tvdbId,
           @seerrRequestId, @mbAlbumId, @mbArtistId, @lidarrAlbumId, @aurralAlbumId, @posterUrl,
           @normTitle, @normArtist, 'pending', @createdAt)`,
      )
      .run({
        discordUserId: r.discordUserId,
        kind: r.kind,
        target: r.target,
        title: r.title,
        year: r.year ?? null,
        artistName: r.artistName ?? null,
        tmdbId: r.tmdbId ?? null,
        tvdbId: r.tvdbId ?? null,
        seerrRequestId: r.seerrRequestId ?? null,
        mbAlbumId: r.mbAlbumId ?? null,
        mbArtistId: r.mbArtistId ?? null,
        lidarrAlbumId: r.lidarrAlbumId ?? null,
        aurralAlbumId: r.aurralAlbumId ?? null,
        posterUrl: r.posterUrl ?? null,
        normTitle: normalizeTitle(r.title),
        normArtist: normalizeTitle(r.artistName),
        createdAt: Date.now(),
      });
    return Number(info.lastInsertRowid);
  }

  pendingRequests(): TrackedRequest[] {
    return (this.db.prepare("SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at").all() as Row[]).map(toRequest);
  }

  /** Every pending request that the given identifiers refer to. */
  findPending(m: MatchKeys): TrackedRequest[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { kind: m.kind };
    const add = (col: string, key: string, value: unknown) => {
      if (value === undefined || value === null || value === "") return;
      clauses.push(`${col} = @${key}`);
      params[key] = value;
    };
    add("tmdb_id", "tmdb", m.tmdbId);
    add("tvdb_id", "tvdb", m.tvdbId);
    add("seerr_request_id", "seerrReq", m.seerrRequestId);
    add("mb_album_id", "mbAlbum", m.mbAlbumId);
    add("lidarr_album_id", "lidarrAlbum", m.lidarrAlbumId);
    add("aurral_album_id", "aurralAlbum", m.aurralAlbumId);
    if (m.kind === "album" && m.title && m.artistName) {
      clauses.push("(norm_title = @normTitle AND norm_artist = @normArtist)");
      params.normTitle = normalizeTitle(m.title);
      params.normArtist = normalizeTitle(m.artistName);
    }
    if (!clauses.length) return [];
    const sql = `SELECT * FROM requests WHERE status = 'pending' AND kind = @kind AND (${clauses.join(" OR ")})`;
    return (this.db.prepare(sql).all(params) as Row[]).map(toRequest);
  }

  /** A member's still-pending requests plus those completed in the last `recentDays`. */
  requestsForUser(userId: string, recentDays = 14): { pending: TrackedRequest[]; done: Array<TrackedRequest & { notifiedAt: number }> } {
    const pending = (this.db.prepare("SELECT * FROM requests WHERE discord_user_id = ? AND status = 'pending' ORDER BY created_at DESC").all(userId) as Row[]).map(toRequest);
    const since = Date.now() - recentDays * 86_400_000;
    const done = (
      this.db
        .prepare("SELECT * FROM requests WHERE discord_user_id = ? AND status = 'notified' AND notified_at >= ? ORDER BY notified_at DESC LIMIT 10")
        .all(userId, since) as Row[]
    ).map((r) => ({ ...toRequest(r), notifiedAt: r.notified_at as number }));
    return { pending, done };
  }

  /** Requests made through the bot since `sinceMs` (for the stats board). */
  requestCountSince(sinceMs: number): { total: number; movie: number; tv: number; album: number } {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS n FROM requests WHERE created_at >= ? GROUP BY kind").all(sinceMs) as Array<{ kind: string; n: number }>;
    const by = Object.fromEntries(rows.map((r) => [r.kind, r.n])) as Record<string, number>;
    return { total: rows.reduce((a, r) => a + r.n, 0), movie: by.movie ?? 0, tv: by.tv ?? 0, album: by.album ?? 0 };
  }

  markNotified(ids: number[]) {
    if (!ids.length) return;
    const stmt = this.db.prepare("UPDATE requests SET status = 'notified', notified_at = ? WHERE id = ?");
    const now = Date.now();
    this.db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
  }

  /** Stops tracking requests older than the cut-off so the reconciler doesn't poll forever. */
  expireOlderThan(cutoffMs: number): number {
    return this.db.prepare("UPDATE requests SET status = 'expired' WHERE status = 'pending' AND created_at < ?").run(cutoffMs).changes;
  }

  updateRequestIds(id: number, ids: { lidarrAlbumId?: number; aurralAlbumId?: string; seerrRequestId?: number }) {
    this.db
      .prepare(
        `UPDATE requests SET
           lidarr_album_id  = COALESCE(@lidarr, lidarr_album_id),
           aurral_album_id  = COALESCE(@aurral, aurral_album_id),
           seerr_request_id = COALESCE(@seerr, seerr_request_id)
         WHERE id = @id`,
      )
      .run({ id, lidarr: ids.lidarrAlbumId ?? null, aurral: ids.aurralAlbumId ?? null, seerr: ids.seerrRequestId ?? null });
  }

  // ---- invite nicknames (Wizarr has codes, not names) ------------------------
  saveInvite(i: StoredInvite) {
    this.db
      .prepare(
        `INSERT INTO invites(name, wizarr_id, code, created_by, created_at, for_user_id)
         VALUES(@name, @wizarrId, @code, @createdBy, @createdAt, @forUserId)
         ON CONFLICT(name) DO UPDATE SET wizarr_id = excluded.wizarr_id, code = excluded.code,
           created_by = excluded.created_by, created_at = excluded.created_at, for_user_id = excluded.for_user_id`,
      )
      .run({ ...i, forUserId: i.forUserId ?? null });
  }
  invites(): StoredInvite[] {
    return (this.db.prepare("SELECT * FROM invites").all() as Row[]).map((r) => ({
      name: r.name as string,
      wizarrId: r.wizarr_id as number,
      code: r.code as string,
      createdBy: r.created_by as string,
      createdAt: r.created_at as number,
      forUserId: (r.for_user_id as string | null) ?? undefined,
    }));
  }
  inviteByName(name: string): StoredInvite | undefined {
    return this.invites().find((i) => i.name.toLowerCase() === name.toLowerCase());
  }
  deleteInvite(wizarrId: number) {
    this.db.prepare("DELETE FROM invites WHERE wizarr_id = ?").run(wizarrId);
  }

  // ---- /report → Seerr issues, so the reporter hears when it's fixed --------
  addReport(r: StoredReport) {
    this.db
      .prepare("INSERT OR REPLACE INTO reports(issue_id, discord_user_id, title, status, created_at) VALUES(?, ?, ?, 'open', ?)")
      .run(r.issueId, r.discordUserId, r.title, r.createdAt);
  }
  openReports(): StoredReport[] {
    return (this.db.prepare("SELECT * FROM reports WHERE status = 'open'").all() as Row[]).map((r) => ({
      issueId: r.issue_id as number,
      discordUserId: r.discord_user_id as string,
      title: r.title as string,
      createdAt: r.created_at as number,
    }));
  }
  /** Marks a report closed; returns it if it was still open (so the reporter is told once). */
  closeReport(issueId: number): StoredReport | undefined {
    const open = this.openReports().find((r) => r.issueId === issueId);
    if (!open) return undefined;
    this.db.prepare("UPDATE reports SET status = 'resolved' WHERE issue_id = ?").run(issueId);
    return open;
  }

  // ---- Aurral accounts made from Discord (one per member) -------------------
  aurralAccount(discordUserId: string): { aurralUserId: number; username: string; createdAt: number } | undefined {
    const r = this.db.prepare("SELECT * FROM aurral_accounts WHERE discord_user_id = ?").get(discordUserId) as Row | undefined;
    return r ? { aurralUserId: r.aurral_user_id as number, username: r.username as string, createdAt: r.created_at as number } : undefined;
  }
  saveAurralAccount(discordUserId: string, aurralUserId: number, username: string, createdBy: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO aurral_accounts(discord_user_id, aurral_user_id, username, created_by, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(discordUserId, aurralUserId, username, createdBy, Date.now());
  }
  deleteAurralAccount(discordUserId: string) {
    this.db.prepare("DELETE FROM aurral_accounts WHERE discord_user_id = ?").run(discordUserId);
  }

  // ---- service up/down memory (so transitions survive restarts) --------------
  serviceStates(): Map<string, { up: boolean; changedAt: number }> {
    const rows = this.db.prepare("SELECT * FROM service_state").all() as Row[];
    return new Map(rows.map((r) => [r.service as string, { up: r.up === 1, changedAt: r.changed_at as number }]));
  }
  setServiceState(service: string, up: boolean, changedAt: number) {
    this.db
      .prepare("INSERT INTO service_state(service, up, changed_at) VALUES(?, ?, ?) ON CONFLICT(service) DO UPDATE SET up = excluded.up, changed_at = excluded.changed_at")
      .run(service, up ? 1 : 0, changedAt);
  }
}
