/** Wizarr REST API client. Interactive docs: <WIZARR_URL>/api/docs/ */
import { request, type RequestOptions } from "../core/http.js";
import type { Config } from "../config.js";

export interface WizarrInvitation {
  id: number;
  code: string;
  url: string; // relative, e.g. /j/ABC123
  status: "pending" | "used" | "expired" | string;
  created?: string | null;
  expires?: string | null;
  used_at?: string | null;
  duration?: string;
  unlimited?: boolean;
  display_name?: string;
  server_names?: string[];
}

export interface WizarrServer {
  id: number;
  name: string;
  server_type: string;
  verified?: boolean;
}

/** Expiry values Wizarr's API accepts (anything else means "never"). */
export const WIZARR_EXPIRY_DAYS = [1, 7, 30] as const;

/** Wizarr returns naive ISO timestamps that are UTC; parse them as such. */
export function wizarrDate(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const hasZone = /(?:Z|[+-]\d\d:?\d\d)$/.test(s);
  const ms = Date.parse(hasZone ? s : `${s}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** An invite still accepts sign-ups: not expired, and either unused or multi-use. */
export function inviteIsValid(inv: WizarrInvitation, now = Date.now()): boolean {
  const expires = wizarrDate(inv.expires);
  if (expires !== undefined && expires <= now) return false;
  if (inv.status === "expired") return false;
  if (inv.status === "used" && !inv.unlimited) return false;
  return true;
}

export class WizarrClient {
  readonly name = "Wizarr";
  private serverIds?: number[];

  constructor(private readonly cfg: NonNullable<Config["wizarr"]>) {}

  private call<T>(path: string, opts: RequestOptions = {}) {
    return request<T>(this.name, `${this.cfg.url}/api${path}`, {
      ...opts,
      headers: { "X-API-Key": this.cfg.apiKey, ...opts.headers },
    });
  }

  async health(): Promise<void> {
    await this.call(`/status`, { timeoutMs: 5000 });
  }

  /** Full link for sharing; uses WIZARR_PUBLIC_URL when set. */
  inviteLink(inv: Pick<WizarrInvitation, "url" | "code">): string {
    const base = this.cfg.publicUrl ?? this.cfg.url;
    const path = inv.url?.startsWith("/") ? inv.url : `/j/${inv.code}`;
    return `${base}${path}`;
  }

  get hasPublicUrl(): boolean {
    return Boolean(this.cfg.publicUrl);
  }

  async invitations(): Promise<WizarrInvitation[]> {
    const res = await this.call<{ invitations?: WizarrInvitation[] }>(`/invitations`);
    return res.invitations ?? [];
  }

  /** Server IDs for new invites: WIZARR_SERVER_IDS, else every verified Plex server, else every verified server. */
  async targetServers(): Promise<number[]> {
    if (this.cfg.serverIds.length) return this.cfg.serverIds;
    if (this.serverIds?.length) return this.serverIds;
    const res = await this.call<{ servers?: WizarrServer[] }>(`/servers`);
    const verified = (res.servers ?? []).filter((s) => s.verified !== false);
    const plex = verified.filter((s) => s.server_type === "plex");
    this.serverIds = (plex.length ? plex : verified).map((s) => s.id);
    if (!this.serverIds.length) throw new Error("Wizarr has no verified media server to invite people to");
    return this.serverIds;
  }

  async createInvitation(opts: { expiresInDays?: 1 | 7 | 30; unlimited: boolean }): Promise<WizarrInvitation> {
    const body: Record<string, unknown> = {
      server_ids: await this.targetServers(),
      // Wizarr treats `unlimited` as "this invite link can be used more than once".
      unlimited: opts.unlimited,
    };
    if (opts.expiresInDays) body.expires_in_days = opts.expiresInDays;
    const res = await this.call<{ invitation: WizarrInvitation }>(`/invitations`, { method: "POST", body });
    return { ...res.invitation, status: "pending" };
  }

  async deleteInvitation(id: number): Promise<void> {
    await this.call(`/invitations/${id}`, { method: "DELETE" });
  }
}
