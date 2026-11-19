/**
 * Ping roles: they only decide who gets @-pinged for which announcements.
 * They don't gate any features. Role IDs come from env (ROLE_*_ID) or are
 * created on first use by /setup and remembered in the DB.
 */
import type { Guild } from "discord.js";
import type { Config } from "../config.js";
import type { Store } from "./db.js";

export type OptCategory = "movies" | "tv" | "music" | "status";

export const OPT_CATEGORIES: Array<{ key: OptCategory; name: string; emoji: string; blurb: string }> = [
  { key: "movies", name: "Movies", emoji: "🎬", blurb: "Ping me when new movies land" },
  { key: "tv", name: "TV", emoji: "📺", blurb: "Ping me when new episodes and shows land" },
  { key: "music", name: "Music", emoji: "🎵", blurb: "Ping me when new albums land" },
  { key: "status", name: "Server status", emoji: "📡", blurb: "Ping me when a service goes down or comes back" },
];

const ROLE_NAMES: Record<OptCategory, string> = { movies: "Movies", tv: "TV", music: "Music", status: "Server status" };
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

  /**
   * Makes sure all four ping roles exist (reusing same-named roles) and returns
   * the names of any it created. Needs the Manage Roles permission.
   */
  async ensure(guild: Guild): Promise<string[]> {
    const created: string[] = [];
    for (const c of OPT_CATEGORIES) {
      const current = this.get(c.key);
      if (current && (await guild.roles.fetch(current).catch(() => null))) continue;
      const existing = guild.roles.cache.find((r) => r.name.toLowerCase() === ROLE_NAMES[c.key].toLowerCase());
      const role =
        existing ??
        (await guild.roles.create({
          name: ROLE_NAMES[c.key],
          // Mentionable so the bot can ping it without the "Mention Everyone" permission.
          mentionable: true,
          reason: `MediaHub ping role (${c.blurb})`,
        }));
      this.set(c.key, role.id);
      if (!existing) created.push(role.name);
    }
    return created;
  }
}
