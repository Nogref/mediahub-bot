/**
 * Safety net for "@ me when it's ready": every REQUEST_RECONCILE_MINUTES the
 * bot asks Seerr / Lidarr / Aurral whether pending bot requests are now
 * available. Covers webhooks that were never set up, or that fired while the
 * bot was down. Webhooks remain the fast path; this only catches stragglers.
 */
import { log } from "../core/logger.js";
import type { TrackedRequest } from "../core/db.js";
import type { AppContext, ModuleFactory } from "../core/module.js";
import { keys, type MediaEvent } from "../notify/events.js";
import { albumComplete } from "../services/lidarr.js";
import { MediaStatus } from "../services/seerr.js";

async function isAvailable({ services }: AppContext, r: TrackedRequest): Promise<boolean> {
  switch (r.target) {
    case "seerr": {
      if (!services.seerr) return false;
      if (r.seerrRequestId) {
        const req = await services.seerr.getRequest(r.seerrRequestId).catch(() => undefined);
        if (req?.media?.status !== undefined) return req.media.status === MediaStatus.AVAILABLE;
      }
      if (!r.tmdbId) return false;
      const d = await services.seerr.details(r.kind === "movie" ? "movie" : "tv", r.tmdbId);
      return d.mediaInfo?.status === MediaStatus.AVAILABLE;
    }
    case "lidarr": {
      if (!services.lidarr) return false;
      const album = r.lidarrAlbumId
        ? await services.lidarr.album(r.lidarrAlbumId)
        : r.mbAlbumId
          ? await services.lidarr.albumByForeignId(r.mbAlbumId)
          : undefined;
      return album ? albumComplete(album) : false;
    }
    case "aurral": {
      if (!services.aurral || !r.aurralAlbumId) return false;
      const st = await services.aurral.albumStatus(r.aurralAlbumId);
      return st.status === "complete";
    }
  }
}

function toEvent(r: TrackedRequest): MediaEvent {
  const base = { type: "media" as const, source: "request tracker", year: r.year, imageUrl: r.posterUrl, confirms: true };
  if (r.kind === "movie") {
    return { ...base, kind: "movie", title: r.title, match: { kind: "movie", tmdbId: r.tmdbId, seerrRequestId: r.seerrRequestId }, dedupeKey: keys.movie(r.tmdbId, r.title, r.year) };
  }
  if (r.kind === "tv") {
    return {
      ...base,
      kind: "series",
      title: r.title,
      match: { kind: "tv", tmdbId: r.tmdbId, tvdbId: r.tvdbId, seerrRequestId: r.seerrRequestId },
      dedupeKey: keys.series({ tmdbId: r.tmdbId, tvdbId: r.tvdbId }, r.title),
    };
  }
  return {
    ...base,
    kind: "album",
    title: r.title,
    subtitle: r.artistName,
    match: { kind: "album", mbAlbumId: r.mbAlbumId, lidarrAlbumId: r.lidarrAlbumId, aurralAlbumId: r.aurralAlbumId, title: r.title, artistName: r.artistName },
    dedupeKey: keys.album(r.artistName, r.title),
  };
}

/** One pass: expire old requests, then publish a "ready" event for each one that's now available. */
export async function checkPendingRequests(ctx: AppContext): Promise<number> {
  const { store, cfg, notifier } = ctx;
  const expired = store.expireOlderThan(Date.now() - cfg.notify.trackDays * 86_400_000);
  if (expired) log.info(`tracker: stopped tracking ${expired} request(s) older than ${cfg.notify.trackDays} days`);
  const ready: MediaEvent[] = [];
  for (const r of store.pendingRequests()) {
    try {
      if (await isAvailable(ctx, r)) ready.push(toEvent(r));
    } catch (err) {
      log.debug(`tracker: could not check request ${r.id} (${r.title}): ${(err as Error).message}`);
    }
  }
  if (ready.length) {
    log.info(`tracker: ${ready.length} tracked request(s) are now available`);
    notifier.publish(ready);
  }
  return ready.length;
}

export const requestTracker: ModuleFactory = (ctx) => {
  const { cfg, services } = ctx;
  if (!cfg.channels.notify || cfg.notify.reconcileMinutes <= 0) return null;
  if (!services.seerr && !services.lidarr && !services.aurral) return null;

  let timer: NodeJS.Timeout | undefined;
  let firstSweep: NodeJS.Timeout | undefined;
  let running = false;

  async function sweep() {
    if (running) return;
    running = true;
    try {
      await checkPendingRequests(ctx);
    } catch (err) {
      log.error(`tracker: sweep failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  return {
    name: "request-tracker",
    start: () => {
      // First sweep shortly after boot, to catch up on anything finished while the bot was offline.
      firstSweep = setTimeout(() => void sweep(), 30_000);
      timer = setInterval(() => void sweep(), cfg.notify.reconcileMinutes * 60_000);
    },
    stop: () => {
      if (firstSweep) clearTimeout(firstSweep);
      if (timer) clearInterval(timer);
    },
  };
};
