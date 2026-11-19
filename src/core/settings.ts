/**
 * Settings changed from Discord (/setup channels, /setup links) live in the
 * DB and override env values. They're applied onto the shared Config object,
 * which every module reads at runtime, so changes take effect immediately
 * and survive restarts without touching the Unraid template.
 */
import type { Config } from "../config.js";
import type { Store } from "./db.js";

export type ChannelKey = keyof Config["channels"];
export type LinkKey = keyof Config["links"];

const KEY = "settings";

interface Stored {
  channels?: Partial<Record<ChannelKey, string | null>>;
  links?: Partial<Record<LinkKey, string | null>>;
}

/** Called once at startup: DB values win over env. `null` means "cleared from Discord". */
export function applyStoredSettings(cfg: Config, store: Store): void {
  const s = store.kvGet<Stored>(KEY) ?? {};
  for (const [k, v] of Object.entries(s.channels ?? {})) cfg.channels[k as ChannelKey] = v ?? undefined;
  for (const [k, v] of Object.entries(s.links ?? {})) cfg.links[k as LinkKey] = v ?? undefined;
}

export function setChannel(cfg: Config, store: Store, key: ChannelKey, id: string | null): void {
  const s = store.kvGet<Stored>(KEY) ?? {};
  store.kvSet(KEY, { ...s, channels: { ...s.channels, [key]: id } });
  cfg.channels[key] = id ?? undefined;
}

export function setLink(cfg: Config, store: Store, key: LinkKey, url: string | null): void {
  const s = store.kvGet<Stored>(KEY) ?? {};
  store.kvSet(KEY, { ...s, links: { ...s.links, [key]: url } });
  cfg.links[key] = url ?? undefined;
}
