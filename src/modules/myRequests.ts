/**
 * /requests → your own requests: the live tracker for each one still on its
 * way, and what landed in the last two weeks.
 */
import { EmbedBuilder, MessageFlags } from "discord.js";
import type { TrackedRequest } from "../core/db.js";
import { Colors, truncate, ts } from "../core/discord.js";
import type { AppContext, ModuleFactory } from "../core/module.js";
import { albumComplete } from "../services/lidarr.js";
import { trackerEmbed } from "../requests/render.js";
import { RequestTrackerStore } from "../requests/store.js";
import { MediaStatus, type SeerrDownload } from "../services/seerr.js";

const ICON: Record<TrackedRequest["kind"], string> = { movie: "🎬", tv: "📺", album: "💿" };
const STUCK_MS = 3 * 86_400_000;
const MAX_CARDS = 4;

function pct(size: number, left: number): number {
  return size > 0 ? Math.max(0, Math.min(100, Math.round(((size - left) / size) * 100))) : 0;
}

function downloadLine(items: Array<{ size: number; sizeLeft: number; eta?: string }>): string {
  const size = items.reduce((a, d) => a + d.size, 0);
  const left = items.reduce((a, d) => a + d.sizeLeft, 0);
  const etas = items.map((d) => (d.eta ? Date.parse(d.eta) : NaN)).filter((n) => Number.isFinite(n) && n > Date.now());
  const eta = etas.length ? ` · done ${ts(Math.max(...etas))}` : "";
  const what = items.length > 1 ? ` (${items.length} files)` : "";
  return `⬇️ Downloading ${pct(size, left)}%${what}${eta}`;
}

/** One-line live status for a pending request. Never throws. */
export async function liveStatus({ services }: Pick<AppContext, "services">, r: TrackedRequest): Promise<string> {
  const quiet = Date.now() - r.createdAt > STUCK_MS;
  const searching = quiet ? "🔎 Still looking. It may not be out yet, or there's no good copy out there" : "🔎 Finding a copy…";
  try {
    if (r.target === "seerr" && services.seerr && r.tmdbId) {
      const d = await services.seerr.details(r.kind === "movie" ? "movie" : "tv", r.tmdbId);
      const mi = d.mediaInfo;
      const dl: SeerrDownload[] = mi?.downloadStatus ?? [];
      if (dl.length) return downloadLine(dl.map((x) => ({ size: x.size, sizeLeft: x.sizeLeft, eta: x.estimatedCompletionTime })));
      switch (mi?.status) {
        case MediaStatus.AVAILABLE:
          return "✅ On Plex now";
        case MediaStatus.PARTIALLY_AVAILABLE:
          return "🟡 Some episodes are on Plex; the rest are still coming";
        case MediaStatus.PROCESSING:
          return searching;
        case MediaStatus.PENDING:
          return "⏳ Waiting for an admin to approve it";
        default:
          return "❔ I can't find this request any more";
      }
    }
    if (r.target === "lidarr" && services.lidarr) {
      const albumId = r.lidarrAlbumId ?? (r.mbAlbumId ? (await services.lidarr.albumByForeignId(r.mbAlbumId))?.id : undefined);
      if (!albumId) return searching;
      const [queue, album] = await Promise.all([services.lidarr.queueFor([albumId]), services.lidarr.album(albumId)]);
      if (queue.length) return downloadLine(queue.map((q) => ({ size: q.size, sizeLeft: q.sizeleft, eta: q.estimatedCompletionTime })));
      if (albumComplete(album)) return "✅ In the music library now";
      const s = album.statistics;
      if (s && s.trackFileCount > 0) return `🟡 ${s.trackFileCount}/${s.totalTrackCount} tracks so far`;
      return searching;
    }
    if (r.target === "aurral" && services.aurral && r.aurralAlbumId) {
      const st = await services.aurral.albumStatus(r.aurralAlbumId);
      switch (st.status) {
        case "complete":
          return "✅ In the music library now";
        case "downloading":
          return "⬇️ Downloading";
        case "queued":
          return "⏳ Waiting in line to download";
        case "partial":
          return "🟡 Partly downloaded";
        case "blocked":
        case "failed":
          return "⚠️ It couldn't download; the admins may need to take a look";
        default:
          return searching;
      }
    }
  } catch {
    return "❔ Couldn't check right now";
  }
  return "❔ Couldn't check right now";
}

export const myRequests: ModuleFactory = (ctx) => {
  const { services, store } = ctx;
  if (!services.seerr && !services.lidarr && !services.aurral) return null;
  const tstore = new RequestTrackerStore(store);

  return {
    name: "my-requests",
    commands: [
      {
        name: "requests",
        description: "Your requests: how each one is going, and what's landed",
        execute: async (i) => {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const { pending, done } = store.requestsForUser(i.user.id);
          if (!pending.length && !done.length) {
            await i.editReply("You haven't requested anything lately. Try `/request movie`, `/request series` or `/request album`.");
            return;
          }
          const label = (r: TrackedRequest) => `${ICON[r.kind]} **${truncate(r.title, 80)}**${r.artistName ? ` by ${truncate(r.artistName, 40)}` : ""}${r.year ? ` (${r.year})` : ""}`;

          // Newest first: a full tracker card for the first few, a line each for the rest.
          const newest = [...pending].sort((a, b) => b.createdAt - a.createdAt);
          const cards = newest.slice(0, MAX_CARDS).map((r) => {
            const t = tstore.get(r.id);
            return t ? trackerEmbed(r, t).setFooter(null) : undefined;
          });
          const rest = newest.filter((_, idx) => idx >= MAX_CARDS || !cards[idx]).slice(0, 10);
          const statuses = await Promise.all(rest.map((r) => liveStatus(ctx, r)));

          const sections: string[] = [];
          if (rest.length) {
            const more = pending.length - cards.filter(Boolean).length - rest.length;
            sections.push(`**Also on the way**\n${rest.map((r, idx) => `${label(r)}\n${statuses[idx]} · asked ${ts(r.createdAt)}`).join("\n\n")}${more > 0 ? `\n…and ${more} more` : ""}`);
          }
          if (done.length) sections.push(`**Landed recently**\n${done.map((r) => `${label(r)} · ${ts(r.notifiedAt)}`).join("\n")}`);
          const embeds = cards.filter((e): e is NonNullable<typeof e> => Boolean(e));
          if (sections.length) {
            embeds.push(
              new EmbedBuilder()
                .setColor(Colors.info)
                .setTitle(embeds.length ? "📨 More of your requests" : "📨 Your requests")
                .setDescription(truncate(sections.join("\n\n"), 3000))
                .setFooter({ text: "I DM you a tracker for each request, and a message when it's ready." }),
            );
          } else if (embeds.length) {
            embeds[embeds.length - 1].setFooter({ text: "I DM you a tracker for each request, and a message when it's ready." });
          }
          // Discord caps a message at 6000 embed characters.
          while (embeds.length > 1 && embeds.reduce((a, e) => a + JSON.stringify(e.toJSON()).length, 0) > 5500) embeds.shift();
          await i.editReply({ content: pending.length ? `**On the way (${pending.length})**` : "", embeds });
        },
      },
    ],
  };
};
