/**
 * Environment-driven configuration.
 *
 * Every integration is optional: if its variables are missing the matching
 * config block is `undefined`, and every module that needs it switches itself off.
 */
import { log } from "./core/logger.js";

export interface ServiceConfig {
  url: string;
}
export interface KeyedServiceConfig extends ServiceConfig {
  apiKey: string;
}

export interface Config {
  discordToken: string;
  guildId: string;
  adminRoleId?: string;
  channels: { status?: string; notify?: string; admin?: string; music?: string };
  /** Opt-in roles. Unset ones are created by /optin setup and remembered in the DB. */
  roles: { movies?: string; tv?: string; music?: string; status?: string };
  invites: { inviterRoleId?: string; maxActive: number; expiryDays: 1 | 7 | 30 };
  dataDir: string;
  http: { port: number; webhookSecret?: string; timeoutMs: number };

  seerr?: KeyedServiceConfig & { publicUrl?: string; attributeUsers: boolean };
  plex?: ServiceConfig & { token: string; movieLibraries: string[] };
  tautulli?: KeyedServiceConfig;
  lidarr?: KeyedServiceConfig & {
    rootFolder?: string;
    qualityProfile?: string;
    metadataProfile?: string;
  };
  aurral?: KeyedServiceConfig;
  navidrome?: ServiceConfig;
  wizarr?: KeyedServiceConfig & { publicUrl?: string; serverIds: number[] };
  radarr?: ServiceConfig & { apiKey?: string };
  sonarr?: ServiceConfig & { apiKey?: string };
  /** Any Subsonic server (Aurral's /rest, Navidrome) used to stream into voice channels. */
  subsonic?: ServiceConfig & { user: string; password: string; bitrate: number; idleMinutes: number };

  music: { primary: "lidarr" | "aurral" };
  notify: {
    batchSeconds: number;
    dedupeHours: number;
    reconcileMinutes: number;
    trackDays: number;
  };
  status: {
    intervalSeconds: number;
    refreshMinutes: number;
    failThreshold: number;
    slowMs: number;
  };
  /** Present in the requested env contract; no feature reads it yet (see README). */
  promoteSecret?: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function num(name: string, fallback: number, min = 0): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    log.warn(`config: ${name}="${raw}" is not a valid number >= ${min}; using ${fallback}`);
    return fallback;
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function list(name: string): string[] {
  return (env(name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validates a base URL, strips trailing slashes and warns about localhost inside Docker. */
function url(name: string): string | undefined {
  const raw = env(name);
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    log.error(`config: ${name}="${raw}" is not a valid URL (expected e.g. http://lidarr:8686). Ignoring it.`);
    return undefined;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    log.error(`config: ${name} must start with http:// or https://. Ignoring it.`);
    return undefined;
  }
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    log.warn(
      `config: ${name} points at ${host}. Inside a container that is the bot itself, not your server. ` +
        `Use the container name on a shared Docker network (e.g. http://lidarr:8686) or the Unraid host IP.`,
    );
  }
  return raw.replace(/\/+$/, "");
}

/** Builds a keyed service block only when both URL and key are present. */
function keyed(prefix: string): KeyedServiceConfig | undefined {
  const u = url(`${prefix}_URL`);
  const k = env(`${prefix}_API_KEY`);
  if (u && k) return { url: u, apiKey: k };
  if (u || k) log.warn(`config: ${prefix} needs both ${prefix}_URL and ${prefix}_API_KEY; ${prefix} features disabled.`);
  return undefined;
}

export function loadConfig(): Config {
  const discordToken = env("DISCORD_TOKEN");
  const guildId = env("GUILD_ID");
  const missing = [!discordToken && "DISCORD_TOKEN", !guildId && "GUILD_ID"].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}. See .env.example.`);
  }

  const seerrBase = keyed("SEERR");
  const lidarrBase = keyed("LIDARR");
  const wizarrBase = keyed("WIZARR");

  const plexUrl = url("PLEX_URL");
  const plexToken = env("PLEX_TOKEN");
  if (Boolean(plexUrl) !== Boolean(plexToken)) {
    log.warn("config: Plex needs both PLEX_URL and PLEX_TOKEN; Plex features disabled.");
  }

  const radarrUrl = url("RADARR_URL");
  const sonarrUrl = url("SONARR_URL");
  const navidromeUrl = url("NAVIDROME_URL");

  const primaryRaw = (env("MUSIC_REQUEST_TARGET") ?? "lidarr").toLowerCase();
  const primary: "lidarr" | "aurral" = primaryRaw === "aurral" ? "aurral" : "lidarr";
  if (primaryRaw !== "lidarr" && primaryRaw !== "aurral") {
    log.warn(`config: MUSIC_REQUEST_TARGET="${primaryRaw}" is not lidarr|aurral; using lidarr.`);
  }

  const subsonicUrl = url("SUBSONIC_URL") ?? url("AURRAL_URL");
  const subsonicUser = env("SUBSONIC_USER");
  const subsonicPassword = env("SUBSONIC_PASSWORD");
  if ((subsonicUser || subsonicPassword) && !(subsonicUrl && subsonicUser && subsonicPassword)) {
    log.warn("config: music streaming needs SUBSONIC_USER, SUBSONIC_PASSWORD and SUBSONIC_URL (or AURRAL_URL); /music disabled.");
  }

  const expiryRaw = num("INVITER_EXPIRY_DAYS", 7, 1);
  const inviterExpiry: 1 | 7 | 30 = expiryRaw === 1 || expiryRaw === 30 ? expiryRaw : 7;
  if (![1, 7, 30].includes(expiryRaw)) log.warn(`config: INVITER_EXPIRY_DAYS must be 1, 7 or 30 (Wizarr's options); using 7.`);

  const serverIds = list("WIZARR_SERVER_IDS")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

  const cfg: Config = {
    discordToken: discordToken!,
    guildId: guildId!,
    adminRoleId: env("ADMIN_ROLE_ID"),
    channels: {
      status: env("STATUS_CHANNEL_ID"),
      notify: env("NOTIFY_CHANNEL_ID"),
      admin: env("ADMIN_CHANNEL_ID"),
      music: env("MUSIC_NOTIFY_CHANNEL_ID"),
    },
    roles: {
      movies: env("ROLE_MOVIES_ID"),
      tv: env("ROLE_TV_ID"),
      music: env("ROLE_MUSIC_ID"),
      status: env("ROLE_STATUS_ID"),
    },
    invites: {
      inviterRoleId: env("INVITER_ROLE_ID"),
      maxActive: num("INVITER_MAX_ACTIVE", 3, 0),
      expiryDays: inviterExpiry,
    },
    dataDir: env("DATA_DIR") ?? "/data",
    http: {
      port: num("WEBHOOK_PORT", 8787, 1),
      webhookSecret: env("WEBHOOK_SECRET"),
      timeoutMs: num("HTTP_TIMEOUT_MS", 10_000, 1000),
    },
    seerr: seerrBase && {
      ...seerrBase,
      publicUrl: url("SEERR_PUBLIC_URL"),
      attributeUsers: bool("SEERR_ATTRIBUTE_USERS", true),
    },
    plex:
      plexUrl && plexToken
        ? { url: plexUrl, token: plexToken, movieLibraries: list("PLEX_MOVIE_LIBRARIES") }
        : undefined,
    tautulli: keyed("TAUTULLI"),
    lidarr: lidarrBase && {
      ...lidarrBase,
      rootFolder: env("LIDARR_ROOT_FOLDER"),
      qualityProfile: env("LIDARR_QUALITY_PROFILE"),
      metadataProfile: env("LIDARR_METADATA_PROFILE"),
    },
    aurral: keyed("AURRAL"),
    navidrome: navidromeUrl ? { url: navidromeUrl } : undefined,
    wizarr: wizarrBase && {
      ...wizarrBase,
      publicUrl: url("WIZARR_PUBLIC_URL"),
      serverIds,
    },
    radarr: radarrUrl ? { url: radarrUrl, apiKey: env("RADARR_API_KEY") } : undefined,
    sonarr: sonarrUrl ? { url: sonarrUrl, apiKey: env("SONARR_API_KEY") } : undefined,
    subsonic:
      subsonicUrl && subsonicUser && subsonicPassword
        ? {
            url: subsonicUrl,
            user: subsonicUser,
            password: subsonicPassword,
            bitrate: num("MUSIC_BITRATE", 128, 32),
            idleMinutes: num("MUSIC_IDLE_MINUTES", 5, 1),
          }
        : undefined,
    music: { primary },
    notify: {
      batchSeconds: num("NOTIFY_BATCH_SECONDS", 60, 1),
      dedupeHours: num("NOTIFY_DEDUPE_HOURS", 6, 0),
      reconcileMinutes: num("REQUEST_RECONCILE_MINUTES", 10, 0),
      trackDays: num("REQUEST_TRACK_DAYS", 30, 1),
    },
    status: {
      intervalSeconds: num("STATUS_INTERVAL_SECONDS", 60, 15),
      refreshMinutes: num("STATUS_REFRESH_MINUTES", 5, 1),
      failThreshold: num("STATUS_FAIL_THRESHOLD", 2, 1),
      slowMs: num("STATUS_SLOW_MS", 2000, 100),
    },
    promoteSecret: env("PROMOTE_SECRET"),
  };

  if (!cfg.http.webhookSecret) {
    log.warn("config: WEBHOOK_SECRET is not set; /webhook/* accepts unauthenticated POSTs from anything that can reach the port.");
  }
  return cfg;
}
