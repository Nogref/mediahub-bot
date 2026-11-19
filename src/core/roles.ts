/**
 * Opt-in roles: who gets pinged for which announcements, and who has music
 * features. Role IDs come from env (ROLE_*_ID) or are created by /optin setup
 * and remembered in the DB.
 */
import type { Config } from "../config.js";
import type { Store } from "./db.js";

export type OptCategory = "movies" | "tv" | "music" | "status";

export const OPT_CATEGORIES: Array<{ key: OptCategory; name: string; emoji: string; blurb: string }> = [
  { key: "movies", name: "Movies", emoji: "🎬", blurb: "Pinged when new movies land" },
  { key: "tv", name: "TV", emoji: "📺", blurb: "Pinged when new episodes and shows land" },
  { key: "music", name: "Music", emoji: "🎵", blurb: "Unlocks album requests and /music, and pings for new albums" },
  { key: "status", name: "Server status", emoji: "📡", blurb: "Pinged when a service goes down or comes back" },
];

const KV_KEY = "optin.roles";

export class RoleDirectory {
  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
  ) {}

  get(cat: OptCategory): string | undefined {
    return this.cfg.roles[cat] ?? this.store.kvGet<Partial<Record<OptCategory, string>>>(KV_KEY)?.[cat];
  }

  set(cat: OptCategory, roleId: string): void {
    const cur = this.store.kvGet<Partial<Record<OptCategory, string>>>(KV_KEY) ?? {};
    this.store.kvSet(KV_KEY, { ...cur, [cat]: roleId });
  }

  /** Music is opt-in only once a Music role exists; before that everyone has it. */
  get musicGated(): boolean {
    return Boolean(this.get("music"));
  }
}
