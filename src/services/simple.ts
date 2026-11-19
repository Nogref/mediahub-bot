/**
 * Services the bot only needs to health-check: Tautulli, Radarr, Sonarr and
 * Navidrome. (Their events reach the bot through webhooks, not polling.)
 */
import { ApiError, request } from "../core/http.js";
import type { Config } from "../config.js";

export interface HealthCheckable {
  readonly name: string;
  health(): Promise<void>;
}

export class TautulliClient implements HealthCheckable {
  readonly name = "Tautulli";
  constructor(private readonly cfg: NonNullable<Config["tautulli"]>) {}

  async health(): Promise<void> {
    const res = await request<{ response?: { result?: string; message?: string } }>(this.name, `${this.cfg.url}/api/v2`, {
      query: { apikey: this.cfg.apiKey, cmd: "status" },
      timeoutMs: 5000,
    });
    if (res.response?.result !== "success") {
      throw new ApiError(this.name, "http", `Tautulli says: ${res.response?.message ?? "not OK"}`);
    }
  }
}

/** Radarr / Sonarr: /api/v3/system/status when a key is given (validates it), else the unauthenticated /ping. */
export class ArrClient implements HealthCheckable {
  constructor(
    readonly name: "Radarr" | "Sonarr",
    private readonly cfg: { url: string; apiKey?: string },
  ) {}

  async health(): Promise<void> {
    if (this.cfg.apiKey) {
      await request(this.name, `${this.cfg.url}/api/v3/system/status`, { headers: { "X-Api-Key": this.cfg.apiKey }, timeoutMs: 5000 });
    } else {
      await request(this.name, `${this.cfg.url}/ping`, { timeoutMs: 5000, as: "text" });
    }
  }
}

export class NavidromeClient implements HealthCheckable {
  readonly name = "Navidrome";
  constructor(private readonly cfg: NonNullable<Config["navidrome"]>) {}

  async health(): Promise<void> {
    await request(this.name, `${this.cfg.url}/ping`, { timeoutMs: 5000, as: "text" });
  }
}
