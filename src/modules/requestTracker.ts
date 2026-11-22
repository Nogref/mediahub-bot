/**
 * Live DM trackers for requests: made with /request, made on the Seerr
 * website (for members who saved their Discord ID in Seerr), and ones that
 * were already waiting before trackers existed.
 */
import { MessageFlags, type MessageComponentInteraction } from "discord.js";
import type { BotModule } from "../core/module.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { dmFallbackChannel } from "../notify/announce.js";
import { buildAdapters } from "../redownload/arr.js";
import { RequestEngine } from "../requests/engine.js";
import { trackerPayload } from "../requests/render.js";
import { RQ_FINAL, RequestTrackerStore } from "../requests/store.js";
import { MediaStatus, posterUrl, type SeerrRequest } from "../services/seerr.js";
import { yearOf } from "../core/discord.js";

/** What /request hands over once Seerr/Lidarr/Aurral has the request. */
export interface RequestCreated {
  id: number;
  reply?: { editReply(p: unknown): Promise<unknown> };
  /** Extra line for the reply, e.g. "an admin needs to finish setting up music downloads". */
  note?: string;
  /** The Seerr request the bot just made (so the Seerr-website check doesn't track it twice). */
  madeSeerrRequest?: number;
}

const SEEN_KEY = "requests.seerrSeen";
const MADE_KEY = "requests.botMadeSeerr";
const SETTLE_MS = 2 * 60_000; // let /request record its own Seerr requests first
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Gap between backfill DMs, so a big backlog doesn't hit Discord's rate limits. */
export const backfillGap = { ms: 1500 };
/** Wait after a webhook before checking, so the file is in place. */
export const nudgeDelay = { ms: 5000 };

export const requestTracker: ModuleFactory = (ctx) => {
  const { cfg, services, store, client, bus, notifier } = ctx;
  if (!services.seerr && !services.lidarr && !services.aurral) return null;

  const adapters = buildAdapters(cfg);
  const tstore = new RequestTrackerStore(store);
  const engine = new RequestEngine({
    store,
    tstore,
    client,
    cfg,
    progress: { services, radarr: adapters.radarr?.api, sonarr: adapters.sonarr?.api },
    fallbackChannel: () => dmFallbackChannel(store, cfg.channels.notify),
  });
  const timers: NodeJS.Timeout[] = [];

  bus.on("request-created", (e: RequestCreated) => {
    if (e.madeSeerrRequest) store.kvSet(MADE_KEY, [...(store.kvGet<number[]>(MADE_KEY) ?? []), e.madeSeerrRequest].slice(-1000));
    engine.track(e.id, { reply: e.reply, note: e.note }).catch((err) => log.error(`requests: couldn't start a tracker for #${e.id}: ${(err as Error).message}`));
  });

  // A webhook said something arrived: check matching trackers now rather than on the next pass.
  notifier.subscribe((ev) => {
    if (ev.type !== "media" || !ev.match) return;
    const ids = store.findPending(ev.match).map((r) => r.id);
    if (ids.length) setTimeout(() => void engine.nudge(ids).catch(() => undefined), nudgeDelay.ms).unref();
  });

  /** Trackers for bot requests from before this update that haven't arrived yet. */
  async function backfillPending() {
    const waiting = store.pendingRequests().filter((r) => !tstore.get(r.id));
    if (!waiting.length) return;
    log.info(`requests: sending trackers for ${waiting.length} request(s) that were already waiting`);
    for (const r of waiting) {
      await engine.track(r.id, { intro: "📬 Here's a live tracker for something you asked for earlier. I'll keep it updated until it's ready." }).catch(() => undefined);
      await sleep(backfillGap.ms);
    }
  }

  /** Requests members made on the Seerr website. */
  async function pollSeerr() {
    const seerr = services.seerr;
    if (!seerr) return;
    const seen = store.kvGet<{ lastId: number }>(SEEN_KEY);
    const recent = (await seerr.recentRequests(seen ? 50 : 100)).sort((a, b) => a.id - b.id);
    const firstRun = !seen;
    let lastId = seen?.lastId ?? 0;
    const cutoff = Date.now() - cfg.notify.trackDays * 86_400_000;
    for (const req of recent) {
      if (req.id <= lastId) continue;
      const created = req.createdAt ? Date.parse(req.createdAt) : Date.now();
      if (Date.now() - created < SETTLE_MS) break; // look again next time
      lastId = req.id;
      // The first run only picks up older requests that are still on their way.
      if (firstRun && (created < cutoff || req.status === 3 || req.media?.status === MediaStatus.AVAILABLE)) continue;
      try {
        await trackSeerrRequest(req, created);
      } catch (err) {
        log.debug(`requests: couldn't track Seerr request ${req.id}: ${(err as Error).message}`);
      }
    }
    store.kvSet(SEEN_KEY, { lastId });
  }

  async function trackSeerrRequest(req: SeerrRequest, createdAt: number) {
    const seerr = services.seerr!;
    // Made with /request: the bot made it as its own Seerr user unless SEERR_ATTRIBUTE_USERS is on.
    if ((store.kvGet<number[]>(MADE_KEY) ?? []).includes(req.id)) return;
    const type = req.type ?? req.media?.mediaType;
    const tmdbId = req.media?.tmdbId;
    if (!type || !tmdbId || !req.requestedBy) return;
    const who = await seerr.discordIdsForUser(req.requestedBy.id);
    if (!who.length) return;
    const d = await seerr.details(type, tmdbId);
    for (const discordUserId of who) {
      const id = store.addRequest({
        discordUserId,
        kind: type === "movie" ? "movie" : "tv",
        target: "seerr",
        title: d.title ?? d.name ?? "Untitled",
        year: yearOf(d.releaseDate ?? d.firstAirDate),
        tmdbId,
        tvdbId: d.externalIds?.tvdbId ?? req.media?.tvdbId,
        seerrRequestId: req.id,
        posterUrl: posterUrl(d.posterPath),
        createdAt,
      });
      await engine.track(id, { intro: "📬 You asked for this on the request website, so here's a live tracker. I'll keep it updated until it's ready." });
    }
  }

  async function onTracker(i: MessageComponentInteraction) {
    const [, action, raw] = i.customId.split(":");
    const id = Number(raw);
    const r = store.requestById(id);
    if (!r || r.discordUserId !== i.user.id) {
      await i.reply({ content: "That tracker isn't yours.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action !== "refresh") return;
    await i.deferUpdate();
    const t = await engine.tick(id);
    if (!t) return;
    await i.editReply({ ...trackerPayload(r, t), content: RQ_FINAL.includes(t.state) ? "" : i.message.content }).catch(() => undefined);
  }

  const mod: BotModule & { engine: RequestEngine; tstore: RequestTrackerStore; backfillPending: () => Promise<void>; pollSeerr: () => Promise<void> } = {
    // exposed for tests
    engine,
    tstore,
    backfillPending,
    pollSeerr,
    name: "request-tracker",
    components: { rqt: onTracker },
    start: () => {
      engine.start();
      const n = tstore.active().length;
      if (n) log.info(`requests: watching ${n} request(s)`);
      timers.push(setTimeout(() => void backfillPending().catch((err) => log.warn(`requests: backfill failed: ${(err as Error).message}`)), 20_000));
      if (services.seerr && cfg.notify.reconcileMinutes > 0) {
        const poll = () => void pollSeerr().catch((err) => log.warn(`requests: couldn't check Seerr for new requests: ${(err as Error).message}`));
        timers.push(setTimeout(poll, 45_000));
        timers.push(setInterval(poll, cfg.notify.reconcileMinutes * 60_000));
      }
    },
    stop: () => {
      engine.stop();
      timers.forEach((t) => clearTimeout(t));
    },
  };
  return mod;
};

export type { RequestEngine };
