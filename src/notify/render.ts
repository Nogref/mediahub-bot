/**
 * Pure rendering of batched events into Discord embeds. Kept free of I/O so
 * it can be unit-tested (see test/render.test.mjs).
 */
import { EmbedBuilder } from "discord.js";
import { Colors, truncate } from "../core/discord.js";
import type { AlertEvent, MediaEvent } from "./events.js";

export interface RenderItem {
  event: MediaEvent;
  /** Discord user IDs who requested this item and are being told it's ready. */
  requesters: string[];
}

const KIND_ICON: Record<MediaEvent["kind"], string> = {
  movie: "🎬",
  series: "📺",
  season: "📺",
  episode: "📺",
  album: "💿",
  track: "🎵",
};

const isMusic = (e: MediaEvent) => e.kind === "album" || e.kind === "track";

export function pad2(n: number | undefined): string {
  return n === undefined ? "??" : String(n).padStart(2, "0");
}

export function itemLabel(e: MediaEvent): string {
  switch (e.kind) {
    case "movie":
      return e.year ? `${e.title} (${e.year})` : e.title;
    case "series":
      return e.title;
    case "season":
      return `${e.groupTitle ?? e.title} — Season ${e.season ?? "?"}`;
    case "episode": {
      const code = `S${pad2(e.season)}E${pad2(e.episode)}`;
      return `${e.groupTitle ?? e.title} — ${code}${e.subtitle ? ` · ${e.subtitle}` : ""}`;
    }
    case "album":
    case "track":
      return e.subtitle ? `${e.title} — ${e.subtitle}` : e.title;
  }
}

/** Merges two reports of the same item, keeping whichever has the richer data. */
export function mergeEvents(a: MediaEvent, b: MediaEvent): MediaEvent {
  return {
    ...a,
    year: a.year ?? b.year,
    overview: a.overview ?? b.overview,
    imageUrl: a.imageUrl ?? b.imageUrl,
    subtitle: a.subtitle ?? b.subtitle,
    confirms: a.confirms || b.confirms,
    match: a.match || b.match ? { ...(b.match ?? {}), ...(a.match ?? {}), kind: (a.match ?? b.match)!.kind } : undefined,
    source: a.source === b.source ? a.source : `${a.source}+${b.source}`,
  };
}

export function mentionList(ids: string[]): string {
  return ids.map((id) => `<@${id}>`).join(" ");
}

/** A single new item gets a full card. */
export function renderSingle(item: RenderItem): EmbedBuilder {
  const e = item.event;
  const embed = new EmbedBuilder()
    .setColor(isMusic(e) ? 0x9b59b6 : Colors.plex)
    .setAuthor({ name: isMusic(e) ? "New in the music library" : "New on Plex" })
    .setTitle(truncate(`${KIND_ICON[e.kind]} ${itemLabel(e)}`, 256))
    .setFooter({ text: `via ${e.source}` })
    .setTimestamp(new Date());
  if (e.overview) embed.setDescription(truncate(e.overview, 400));
  if (e.imageUrl && /^https?:\/\//.test(e.imageUrl)) embed.setThumbnail(e.imageUrl);
  if (item.requesters.length) embed.addFields({ name: "Requested by", value: mentionList(item.requesters), inline: true });
  return embed;
}

/** Collapses a run of episodes into "S01E01–E05" style text. */
export function episodeRuns(eps: MediaEvent[]): string {
  const sorted = [...eps].sort((x, y) => (x.season ?? 0) - (y.season ?? 0) || (x.episode ?? 0) - (y.episode ?? 0));
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (
      j + 1 < sorted.length &&
      sorted[j + 1].season === sorted[i].season &&
      sorted[j + 1].episode !== undefined &&
      sorted[j].episode !== undefined &&
      sorted[j + 1].episode === sorted[j].episode! + 1
    ) {
      j++;
    }
    const start = `S${pad2(sorted[i].season)}E${pad2(sorted[i].episode)}`;
    parts.push(j > i ? `${start}–E${pad2(sorted[j].episode)}` : start);
    i = j + 1;
  }
  return parts.join(", ");
}

/** Several new items in one window become one summary card, grouped by type. */
export function renderSummary(items: RenderItem[]): EmbedBuilder {
  const by = (kinds: MediaEvent["kind"][]) => items.filter((it) => kinds.includes(it.event.kind));
  const req = (it: RenderItem) => (it.requesters.length ? ` — requested by ${mentionList(it.requesters)}` : "");
  const sections: string[] = [];

  const movies = by(["movie"]);
  if (movies.length) sections.push(`**🎬 Movies**\n${movies.map((it) => `• ${itemLabel(it.event)}${req(it)}`).join("\n")}`);

  const tv = by(["series", "season", "episode"]);
  if (tv.length) {
    const groups = new Map<string, RenderItem[]>();
    for (const it of tv) {
      const show = it.event.groupTitle ?? it.event.title;
      groups.set(show, [...(groups.get(show) ?? []), it]);
    }
    const lines: string[] = [];
    for (const [show, group] of groups) {
      const requesters = [...new Set(group.flatMap((g) => g.requesters))];
      const eps = group.filter((g) => g.event.kind === "episode").map((g) => g.event);
      const seasons = group.filter((g) => g.event.kind === "season").map((g) => `Season ${g.event.season ?? "?"}`);
      const detail = [...seasons, eps.length ? episodeRuns(eps) : ""].filter(Boolean).join(", ");
      const epCount = eps.length > 1 ? ` (${eps.length} episodes)` : "";
      lines.push(`• ${show}${detail ? ` — ${detail}` : ""}${epCount}${requesters.length ? ` — requested by ${mentionList(requesters)}` : ""}`);
    }
    sections.push(`**📺 TV**\n${lines.join("\n")}`);
  }

  const music = by(["album", "track"]);
  if (music.length) sections.push(`**💿 Music**\n${music.map((it) => `• ${itemLabel(it.event)}${req(it)}`).join("\n")}`);

  let description = sections.join("\n\n");
  if (description.length > 4000) {
    const cut = description.slice(0, 3900);
    const shownLines = cut.split("\n").filter((l) => l.startsWith("•")).length;
    const totalLines = description.split("\n").filter((l) => l.startsWith("•")).length;
    description = `${cut.slice(0, cut.lastIndexOf("\n"))}\n…and ${Math.max(1, totalLines - shownLines + 1)} more`;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.plex)
    .setTitle(`🆕 ${items.length} new additions`)
    .setDescription(description)
    .setTimestamp(new Date());
  const thumb = items.find((it) => it.event.imageUrl && /^https?:\/\//.test(it.event.imageUrl))?.event.imageUrl;
  if (thumb) embed.setThumbnail(thumb);
  return embed;
}

const LEVEL: Record<AlertEvent["level"], { icon: string; color: number }> = {
  ok: { icon: "🟢", color: Colors.ok },
  info: { icon: "ℹ️", color: Colors.info },
  warn: { icon: "🟡", color: Colors.warn },
  error: { icon: "🔴", color: Colors.bad },
};

export function renderAlerts(alerts: AlertEvent[]): EmbedBuilder {
  if (alerts.length === 1) {
    const a = alerts[0];
    return new EmbedBuilder()
      .setColor(LEVEL[a.level].color)
      .setTitle(truncate(`${LEVEL[a.level].icon} ${a.title}`, 256))
      .setDescription(a.message ? truncate(a.message, 2000) : null)
      .setFooter({ text: `via ${a.source}` })
      .setTimestamp(new Date());
  }
  const worst = alerts.some((a) => a.level === "error") ? "error" : alerts.some((a) => a.level === "warn") ? "warn" : "info";
  const lines = alerts.map((a) => `${LEVEL[a.level].icon} **${a.title}**${a.message ? ` — ${truncate(a.message, 200)}` : ""}`);
  return new EmbedBuilder()
    .setColor(LEVEL[worst].color)
    .setTitle(`🛠️ ${alerts.length} service notices`)
    .setDescription(truncate(lines.join("\n"), 4000))
    .setTimestamp(new Date());
}
