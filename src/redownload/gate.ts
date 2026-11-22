/**
 * Shared member checks for the self-serve features (redownloads, missing
 * content): a linked Plex account that's still on the server's share list.
 * Only used while `/admin redownloads plexcheck` is on.
 */
import { log } from "../core/logger.js";
import type { PlexTvClient } from "../services/plextv.js";
import type { RedownloadStore } from "./store.js";

const REVERIFY_MS = 6 * 3_600_000;
const REVERIFY_GRACE_MS = 7 * 86_400_000;

export type PlexCheck = { ok: true; username: string } | { ok: false; reason: string };

/** Linked, and that Plex account is (still) on the share list. Re-checked every few hours. */
export async function confirmedPlex(rstore: RedownloadStore, plexTv: PlexTvClient | undefined, userId: string): Promise<PlexCheck> {
  if (!plexTv) return { ok: false, reason: "This needs the bot connected to Plex (PLEX_URL and PLEX_TOKEN) so members can be confirmed. Ask an admin." };
  const l = rstore.link(userId);
  if (!l) return { ok: false, reason: "🔗 First, link your Plex account with `/plex`. It's a one-time sign-in so I know you're on the server." };
  if (Date.now() - l.verifiedAt > REVERIFY_MS) {
    try {
      l.hasAccess = await plexTv.hasAccess(l.plexUserId);
      rstore.setVerified(userId, l.hasAccess);
    } catch (err) {
      log.warn(`plex check: couldn't re-check Plex access for ${userId}: ${(err as Error).message}`);
      if (Date.now() - l.verifiedAt > REVERIFY_GRACE_MS) return { ok: false, reason: "I couldn't reach Plex to confirm your access. Try again in a few minutes." };
    }
  }
  if (!l.hasAccess) {
    return { ok: false, reason: `Your linked Plex account (**${l.plexUsername}**) isn't on this server's share list any more, so this is locked. Ask an admin if that's wrong.` };
  }
  return { ok: true, username: l.plexUsername };
}
