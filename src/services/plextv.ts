/**
 * plex.tv: the sign-in PIN flow (so members can link their Plex account) and
 * the owner's share list (to confirm they actually have access to our server).
 * Member tokens are used once to read their account id, then thrown away.
 */
import { randomUUID } from "node:crypto";
import { request } from "../core/http.js";
import type { Store } from "../core/db.js";
import { TtlCache } from "../core/ttlCache.js";
import type { PlexClient } from "./plex.js";

const PRODUCT = "MediaHub Bot";

export interface PlexAccount {
  id: number;
  username: string;
  title?: string;
}

export const HOME = "*home*";

/** Parses plex.tv/api/users XML into user id → server machine ids. */
export function parseSharedUsers(xml: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const attrs = (s: string) => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  for (const m of xml.matchAll(/<User\b([^>]*?)(?:\/>|>([\s\S]*?)<\/User>)/g)) {
    const user = attrs(m[1]);
    const id = Number(user.id);
    if (!Number.isFinite(id)) continue;
    const servers = [...(m[2] ?? "").matchAll(/<Server\b([^>]*?)\/?>/g)].map((s) => attrs(s[1]).machineIdentifier).filter(Boolean);
    if (user.home === "1") servers.push(HOME); // Plex Home members use the owner's servers
    out.set(id, servers);
  }
  return out;
}

export class PlexTvClient {
  private clientId: string;
  private shared = new TtlCache<string, Map<number, string[]>>(15 * 60_000);
  private ownerId?: number;

  constructor(
    private readonly baseUrl: string,
    private readonly ownerToken: string,
    private readonly plex: PlexClient,
    store: Store,
  ) {
    // A stable identity for this bot, so Plex shows one "MediaHub Bot" device.
    this.clientId = store.kvGet<string>("plex.clientId") ?? randomUUID();
    store.kvSet("plex.clientId", this.clientId);
  }

  private headers(token?: string): Record<string, string> {
    return {
      Accept: "application/json",
      "X-Plex-Product": PRODUCT,
      "X-Plex-Version": "1.0",
      "X-Plex-Client-Identifier": this.clientId,
      "X-Plex-Device-Name": "MediaHub Discord bot",
      ...(token ? { "X-Plex-Token": token } : {}),
    };
  }

  async createPin(): Promise<{ id: number; code: string }> {
    const r = await request<{ id: number; code: string }>("Plex.tv", `${this.baseUrl}/api/v2/pins?strong=true`, { method: "POST", headers: this.headers() });
    return { id: r.id, code: r.code };
  }

  authUrl(code: string): string {
    const params = new URLSearchParams({ clientID: this.clientId, code, "context[device][product]": PRODUCT });
    return `https://app.plex.tv/auth#?${params.toString()}`;
  }

  /** The member's token once they've signed in, else undefined. */
  async pinToken(id: number): Promise<string | undefined> {
    const r = await request<{ authToken?: string | null }>("Plex.tv", `${this.baseUrl}/api/v2/pins/${id}`, { headers: this.headers() });
    return r.authToken ?? undefined;
  }

  async account(token: string): Promise<PlexAccount> {
    const r = await request<{ user: PlexAccount }>("Plex.tv", `${this.baseUrl}/users/account.json`, { headers: this.headers(token) });
    return { id: Number(r.user.id), username: r.user.username ?? r.user.title ?? "plex user", title: r.user.title };
  }

  /** True when this Plex account owns our server or is on its share list. */
  async hasAccess(plexUserId: number): Promise<boolean> {
    this.ownerId ??= (await this.account(this.ownerToken)).id;
    if (plexUserId === this.ownerId) return true;
    const machineId = await this.plex.machineIdentifier();
    if (!machineId) throw new Error("Couldn't read the Plex server's identity");
    let users = this.shared.get("all");
    if (!users) {
      const xml = await request<string>("Plex.tv", `${this.baseUrl}/api/users`, { headers: { ...this.headers(this.ownerToken), Accept: "application/xml" }, as: "text" });
      users = parseSharedUsers(xml);
      this.shared.set("all", users);
    }
    const servers = users.get(plexUserId) ?? [];
    return servers.includes(machineId) || servers.includes(HOME);
  }

  forgetCache(): void {
    this.shared.delete("all");
  }
}

const shared = new WeakMap<object, PlexTvClient>();

/** One plex.tv client per running bot (shares the share-list cache between features). */
export function plexTvFor(ctx: { cfg: { plexTvUrl: string; plex?: { token: string } }; services: { plex?: PlexClient }; store: Store }): PlexTvClient | undefined {
  if (!ctx.cfg.plex || !ctx.services.plex) return undefined;
  let c = shared.get(ctx.services);
  if (!c) {
    c = new PlexTvClient(ctx.cfg.plexTvUrl, ctx.cfg.plex.token, ctx.services.plex, ctx.store);
    shared.set(ctx.services, c);
  }
  return c;
}
