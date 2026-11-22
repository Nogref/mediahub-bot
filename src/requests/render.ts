/** The member's request tracker: plain words, no app names. */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { TrackedRequest } from "../core/db.js";
import { Colors, truncate } from "../core/discord.js";
import { RQ_FINAL, type RqTracker, type SeasonProgress } from "./store.js";

const t = (ms: number, style = "R") => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function bar(p: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, p)) / 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${p}%`;
}

export function requestLabel(r: TrackedRequest): string {
  if (r.kind === "album") return `${r.title}${r.artistName ? ` by ${r.artistName}` : ""}`;
  return `${r.title}${r.year ? ` (${r.year})` : ""}`;
}

const ICON = { movie: "🎬", tv: "📺", album: "💿" } as const;

function downloadText(tr: RqTracker): string {
  if (tr.queueStatus && /queued|delay|paused/i.test(tr.queueStatus) && !tr.progress) return "Waiting in line to download";
  if (tr.progress === undefined) return "Starting the download…";
  const eta = tr.eta && Date.parse(tr.eta) > Date.now() ? ` · done ${t(Date.parse(tr.eta))}` : "";
  return `Downloading  ${bar(tr.progress)}${eta}${tr.stalledAt ? "\n    *Stuck for a while. The admins know*" : tr.queueStatus === "warning" ? "\n    *Going slowly right now, still trying*" : ""}`;
}

/** Movies and albums: request → find → download → ready. */
function steps(r: TrackedRequest, tr: RqTracker): string[] {
  const order = ["requested", "find", "download", "ready"] as const;
  const at: Record<string, number> = { approval: 0, not_out: 1, searching: 1, stalled: 1, downloading: 2, done: 4 };
  const pos = at[tr.state] ?? 1;
  const ready = r.kind === "album" ? "In the music library" : "On Plex";
  const text = {
    requested: tr.state === "approval" ? "Requested · ⏳ waiting for an admin to approve it" : "Requested",
    find:
      tr.state === "not_out"
        ? `${r.kind === "album" ? "Not out yet" : "Not out to watch at home yet"}${tr.releaseAt ? ` (expected ${t(tr.releaseAt, "D")})` : ""}. It downloads as soon as it is`
        : tr.state === "stalled"
          ? "Still looking: there's no copy out there yet. I've told the admins, and I'm still watching"
          : pos > 1
            ? "Found a copy"
            : "Finding a copy…",
    download: tr.state === "downloading" ? downloadText(tr) : pos > 2 ? "Downloaded" : "Download",
    ready: tr.state === "done" ? `${ready} ✨` : ready,
  };
  return order.map((k, i) => `${i < pos ? "✅" : i === pos ? "▶️" : "⬜"} ${text[k]}`);
}

function seasonLine(s: SeasonProgress): string {
  const name = `**Season ${s.season}**`;
  if (s.coarse) {
    const what = s.coarse === "available" ? "✅ on Plex" : s.coarse === "partial" ? "🟡 partly on Plex" : s.downloading ? `⬇️ ${s.downloading} downloading` : "🔎 finding it";
    return `${name}: ${what}`;
  }
  if (s.aired === 0) return `${name}: 🗓️ ${s.startsAt ? `starts ${t(s.startsAt, "D")}` : "hasn't aired yet"}`;
  const still = s.upcoming ? ` · ${s.upcoming} still to air` : "";
  if (s.onPlex >= s.aired) return `${name}: ✅ all ${s.aired} on Plex${still}`;
  const p = Math.round((s.onPlex / s.aired) * 100);
  const dl = s.downloading ? ` · ⬇️ ${s.downloading} downloading${s.progress !== undefined ? ` (${s.progress}%)` : ""}` : "";
  return `${name}: ${s.onPlex} of ${s.aired} on Plex ${bar(p).replace(/ \d+%$/, "")}${dl}${still}`;
}

const ENDED: Record<string, { title: string; color: number }> = {
  done: { title: "✅ Ready", color: Colors.ok },
  declined: { title: "🚫 Not approved", color: Colors.muted },
  expired: { title: "⌛ Stopped watching", color: Colors.muted },
};

export function trackerEmbed(r: TrackedRequest, tr: RqTracker): EmbedBuilder {
  const label = requestLabel(r);
  const e = new EmbedBuilder().setFooter({ text: "/requests shows this anytime" });
  if (r.posterUrl) e.setThumbnail(r.posterUrl);
  const end = ENDED[tr.state];
  // Movies and albums spell out waiting/stalled in their steps; TV has no steps, so it says it up top.
  const tv = r.kind === "tv";
  const head =
    tr.state === "done"
      ? r.kind === "album"
        ? "It's in the music library now. Enjoy!"
        : "It's on Plex now. Enjoy!"
      : tr.state === "declined"
        ? "An admin didn't approve this request."
        : tr.state === "expired"
          ? "It still hadn't turned up, so I've stopped watching for it. The admins know about it."
          : !tv
            ? ""
            : tr.state === "approval"
              ? "⏳ Waiting for an admin to approve it."
              : tr.state === "stalled"
                ? "😕 There's no copy of the missing episodes out there yet. I've let the admins know, and I'm still watching."
                : tr.state === "not_out"
                  ? "🗓️ Not out yet. It downloads as soon as it airs."
                  : "New episodes show up on Plex one by one as they finish.";
  const body = r.kind === "tv" && tr.seasons?.length ? tr.seasons.slice(0, 20).map(seasonLine) : r.kind !== "tv" ? steps(r, tr) : [tr.state === "downloading" ? `⬇️ ${downloadText(tr)}` : "🔎 Finding it…"];
  e.setColor(end?.color ?? (tr.state === "stalled" ? Colors.warn : Colors.info))
    .setTitle(truncate(`${end ? `${end.title}: ` : `${ICON[r.kind]} `}${label}`, 256))
    .setDescription(
      `${head ? `${head}\n\n` : ""}${body.join("\n")}${RQ_FINAL.includes(tr.state) ? "" : `\n-# Requested ${t(r.createdAt)} · updated ${t(tr.updatedAt)}`}`,
    );
  return e;
}

export function trackerButtons(tr: RqTracker): ActionRowBuilder<ButtonBuilder>[] {
  if (RQ_FINAL.includes(tr.state)) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rqt:refresh:${tr.requestId}`).setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function trackerPayload(r: TrackedRequest, tr: RqTracker) {
  return { content: RQ_FINAL.includes(tr.state) ? "" : (tr.intro ?? ""), embeds: [trackerEmbed(r, tr)], components: trackerButtons(tr) };
}

/** Only edit the card when something visible changed. */
export function signature(tr: RqTracker): string {
  const seasons = (tr.seasons ?? []).map((s) => `${s.season}:${s.onPlex}/${s.aired}/${s.downloading}/${s.coarse ?? ""}/${s.progress === undefined ? "" : Math.floor(s.progress / 10)}`).join(",");
  return [tr.state, tr.stalledAt ? 1 : 0, tr.progress === undefined ? "" : Math.floor(tr.progress / 5), tr.eta ? Math.floor(Date.parse(tr.eta) / 300_000) : "", tr.queueStatus, tr.releaseAt, seasons, tr.tracks?.have].join("|");
}
