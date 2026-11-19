/**
 * /requests → your own requests made through the bot: what's still on its way
 * (with live download progress) and what landed in the last two weeks.
 */
import { EmbedBuilder, MessageFlags } from "discord.js";
import type { TrackedRequest } from "../core/db.js";
import { Colors, truncate, ts } from "../core/discord.js";
import type { AppContext, ModuleFactory } from "../core/module.js";
import { albumComplete } from "../services/lidarr.js";
import { MediaStatus, type SeerrDownload } from "../services/seerr.js";

const ICON: Record<TrackedRequest["kind"], string> = { movie: "🎬", tv: "📺", album: "💿" };
const STUCK_MS = 3 * 86_400_000;

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
  const searching = quiet ? "🔎 Still searching. It may not be released yet, or no good copy is available" : "🔎 Searching for a release";
  try {
    if (r.target === "seerr" && services.seerr && r.tmdbId) {
      const d = await services.seerr.details(r.kind === "movie" ? "movie" : "tv", r.tmdbId);
      const mi = d.mediaInfo;
      const dl: SeerrDownload[] = mi?.downloadStatus ?? [];
      if (dl.length) return downloadLine(dl.map((x) => ({ size: x.size, sizeLeft: x.sizeLeft, eta: x.estimatedCompletionTime })));
      switch (mi?.status) {
        case MediaStatus.AVAILABLE:
          return "✅ On Plex now (the ping is on its way)";
        case MediaStatus.PARTIALLY_AVAILABLE:
          return "🟡 Some episodes are on Plex; the rest are still coming";
        case MediaStatus.PROCESSING:
          return searching;
        case MediaStatus.PENDING:
          return "⏳ Waiting in Seerr";
        default:
          return "❔ Seerr doesn't show it as requested any more";
      }
    }
    if (r.target === "lidarr" && services.lidarr) {
      const albumId = r.lidarrAlbumId ?? (r.mbAlbumId ? (await services.lidarr.albumByForeignId(r.mbAlbumId))?.id : undefined);
      if (!albumId) return searching;
      const [queue, album] = await Promise.all([services.lidarr.queueFor([albumId]), services.lidarr.album(albumId)]);
      if (queue.length) return downloadLine(queue.map((q) => ({ size: q.size, sizeLeft: q.sizeleft, eta: q.estimatedCompletionTime })));
      if (albumComplete(album)) return "✅ In the library (the ping is on its way)";
      const s = album.statistics;
      if (s && s.trackFileCount > 0) return `🟡 ${s.trackFileCount}/${s.totalTrackCount} tracks so far`;
      return searching;
    }
    if (r.target === "aurral" && services.aurral && r.aurralAlbumId) {
      const st = await services.aurral.albumStatus(r.aurralAlbumId);
      switch (st.status) {
        case "complete":
          return "✅ In the library (the ping is on its way)";
        case "downloading":
          return "⬇️ Downloading";
        case "queued":
          return "⏳ Queued in Aurral";
        case "partial":
          return "🟡 Partly downloaded";
        case "blocked":
        case "failed":
          return "⚠️ Aurral couldn't download it; an admin may need to look";
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

  return {
    name: "my-requests",
    commands: [
      {
        name: "requests",
        description: "Your requests: what's on its way and what's landed",
        execute: async (i) => {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const { pending, done } = store.requestsForUser(i.user.id);
          if (!pending.length && !done.length) {
            await i.editReply("You haven't requested anything through the bot lately. Try `/request movie`, `/request series` or `/request album`.");
            return;
          }
          const shown = pending.slice(0, 10);
          const statuses = await Promise.all(shown.map((r) => liveStatus(ctx, r)));
          const label = (r: TrackedRequest) => `${ICON[r.kind]} **${truncate(r.title, 80)}**${r.artistName ? ` — ${truncate(r.artistName, 40)}` : ""}${r.year ? ` (${r.year})` : ""}`;

          const sections: string[] = [];
          if (shown.length) {
            const lines = shown.map((r, idx) => `${label(r)}\n${statuses[idx]} · asked ${ts(r.createdAt)}`);
            const more = pending.length > shown.length ? `\n…and ${pending.length - shown.length} more` : "";
            sections.push(`**On the way (${pending.length})**\n${lines.join("\n\n")}${more}`);
          }
          if (done.length) sections.push(`**Landed recently**\n${done.map((r) => `${label(r)} · ${ts(r.notifiedAt)}`).join("\n")}`);
          const embed = new EmbedBuilder().setColor(Colors.info).setTitle("📨 Your requests").setDescription(truncate(sections.join("\n\n"), 4000));
          embed.setFooter({ text: "You'll be @-mentioned when each one is ready." });
          await i.editReply({ embeds: [embed] });
        },
      },
    ],
  };
};
