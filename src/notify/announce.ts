/**
 * Public "new on Plex" announcements are off unless an admin turns them on
 * (`/setup announcements`). Requesters always hear about their own requests
 * by DM, with a live tracker, either way.
 */
import type { Store } from "../core/db.js";

const KEY = "announcements";

export function announcementsOn(store: Store): boolean {
  return store.kvGet<{ enabled: boolean }>(KEY)?.enabled === true;
}

export function setAnnouncements(store: Store, enabled: boolean): void {
  store.kvSet(KEY, { enabled });
}

/** Where to @ someone whose DMs are closed: the announcements channel, but only while announcements are on. */
export function dmFallbackChannel(store: Store, notifyChannel: string | undefined): string | undefined {
  return notifyChannel && announcementsOn(store) ? notifyChannel : undefined;
}
