/** What members and admins see for a missing-content job. Members get plain words; admins get the details. */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { Colors, truncate } from "../core/discord.js";
import type { ItemState, MissingItem, MissingJob, MissingState } from "./store.js";

const t = (ms: number, style = "R") => `<t:${Math.floor(ms / 1000)}:${style}>`;

function bar(pct: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${pct}%`;
}

export const ENDED: MissingState[] = ["done", "partial", "not_found", "failed", "cancelled", "denied"];

const ICON: Record<ItemState, string> = {
  searching: "🔎",
  downloading: "⬇️",
  imported: "✅",
  not_found: "😕",
  failed: "⚠️",
  stuck: "🧰",
};

/** One line per episode, in plain words. */
export function itemLine(it: MissingItem, jobState: MissingState): string {
  if (jobState === "awaiting_approval") return `⏳ ${it.label}`;
  let what: string;
  switch (it.state) {
    case "searching":
      what = jobState === "cancelled" ? "not started" : "looking for it…";
      break;
    case "downloading":
      if (it.queueStatus && /queued|delay|paused/i.test(it.queueStatus) && !it.progress) what = "waiting in line to download";
      else if (it.progress === undefined) what = "starting the download";
      else {
        const eta = it.eta && Date.parse(it.eta) > Date.now() ? ` · done ${t(Date.parse(it.eta))}` : "";
        what = `${bar(it.progress)}${eta}`;
      }
      break;
    case "imported":
      what = "on Plex";
      break;
    case "not_found":
      what = "not available anywhere right now";
      break;
    case "failed":
      what = "couldn't finish downloading";
      break;
    case "stuck":
      what = "downloaded, an admin needs to finish it";
      break;
  }
  return `${ICON[it.state]} ${it.label}: ${what}`;
}

function counts(j: MissingJob) {
  const by = (s: ItemState) => j.items.filter((i) => i.state === s).length;
  return { imported: by("imported"), missing: by("not_found"), failed: by("failed") + by("stuck"), total: j.items.length };
}

const END_TEXT: Record<string, (j: MissingJob) => { title: string; color: number; body: string }> = {
  done: (j) => ({
    title: "✅ All there",
    color: Colors.ok,
    body: `${j.items.length === 1 ? "It's" : `All ${j.items.length} are`} on Plex now. Enjoy!`,
  }),
  partial: (j) => {
    const c = counts(j);
    return {
      title: "✅ Mostly there",
      color: Colors.ok,
      body: `Got ${c.imported} of ${c.total}. The rest couldn't be found or finished right now, and I've let the admins know.`,
    };
  },
  not_found: (j) => ({
    title: "😕 Couldn't find it",
    color: Colors.bad,
    body: `I looked everywhere I can, but ${j.items.length === 1 ? "there's no copy" : "none of these are"} available right now. I've let the admins know so they can take a look.`,
  }),
  failed: () => ({ title: "⚠️ Couldn't finish", color: Colors.bad, body: "Something went wrong getting these. I've let the admins know." }),
  cancelled: () => ({ title: "🛑 Cancelled", color: Colors.muted, body: "Stopped. Anything that already finished is still on Plex." }),
  denied: (j) => ({ title: "🚫 Not approved", color: Colors.muted, body: `An admin didn't approve this one${j.outcome ? ` (${truncate(j.outcome, 200)})` : ""}.` }),
};

export function trackerEmbed(j: MissingJob): EmbedBuilder {
  const e = new EmbedBuilder().setFooter({ text: `Missing #${j.id} · /missing shows this anytime` });
  if (j.target.posterUrl) e.setThumbnail(j.target.posterUrl);
  const lines = j.items.slice(0, 25).map((it) => itemLine(it, j.state));
  if (j.items.length > 25) lines.push(`…and ${j.items.length - 25} more`);
  const end = END_TEXT[j.state]?.(j);
  if (end) {
    return e
      .setColor(end.color)
      .setTitle(truncate(`${end.title}: ${j.target.label}`, 256))
      .setDescription(`${end.body}\n\n${lines.join("\n")}`);
  }
  const head =
    j.state === "awaiting_approval"
      ? "⏳ Waiting for an admin to OK it."
      : j.state === "searching"
        ? "🔎 Looking for these now. This can take a minute or two."
        : "⬇️ Downloading. They'll show up on Plex one by one as they finish.";
  return e
    .setColor(Colors.info)
    .setTitle(truncate(`${j.target.kind === "movie" ? "🎬" : "📺"} Getting ${j.target.label}`, 256))
    .setDescription(`${head}\n\n${lines.join("\n")}\n-# Started ${t(j.createdAt)} · updated ${t(j.updatedAt)}`);
}

export function trackerButtons(j: MissingJob): ActionRowBuilder<ButtonBuilder>[] {
  if (ENDED.includes(j.state)) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mst:refresh:${j.id}`).setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mst:cancel:${j.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function trackerPayload(j: MissingJob) {
  return { content: "", embeds: [trackerEmbed(j)], components: trackerButtons(j) };
}

/** Only edit the member's card when something they'd see changed. */
export function trackerSignature(j: MissingJob): string {
  return [j.state, ...j.items.map((i) => `${i.state}${i.progress === undefined ? "" : Math.floor(i.progress / 5)}${i.queueStatus ?? ""}${i.eta ? Math.floor(Date.parse(i.eta) / 300_000) : ""}`)].join("|");
}

// ---- admin log ------------------------------------------------------------------------------
const LOG_STATE: Record<MissingState, string> = {
  awaiting_approval: "⏳ Waiting for an admin to approve",
  searching: "🔎 Searching",
  downloading: "⬇️ Downloading",
  done: "✅ Everything arrived",
  partial: "🟡 Some arrived, some didn't",
  not_found: "😕 Nothing found",
  failed: "⚠️ Failed",
  cancelled: "🛑 Cancelled",
  denied: "🚫 Denied",
};

export function logEmbed(j: MissingJob): EmbedBuilder {
  const c = counts(j);
  const e = new EmbedBuilder()
    .setColor(j.state === "done" ? Colors.ok : j.state === "partial" || j.state === "awaiting_approval" ? Colors.warn : ENDED.includes(j.state) && j.state !== "cancelled" ? Colors.bad : Colors.info)
    .setTitle(truncate(`🔎 Missing #${j.id} · ${j.target.label}`, 256))
    .setDescription(`**${LOG_STATE[j.state]}**${j.outcome ? `\n${j.outcome}` : ""}`)
    .addFields(
      { name: "Requested by", value: `<@${j.discordUserId}>${j.plexUsername ? ` · Plex: ${j.plexUsername}` : ""}${j.bypassLimits ? " · admin" : ""}` },
      {
        name: `${j.target.kind === "movie" ? "Movie" : "Episodes"} (${c.imported}/${c.total} on Plex)`,
        value: truncate(
          j.items
            .map((i) => `${ICON[i.state]} ${i.label}${i.message && i.state !== "imported" ? ` · ${truncate(i.message, 80)}` : ""}`)
            .join("\n"),
          1024,
        ),
      },
    )
    .setFooter({ text: `${j.target.app} · ${j.phase ?? "not started"} · id ${j.id}` })
    .setTimestamp(new Date(j.updatedAt));
  if (j.events.length) e.addFields({ name: "Timeline", value: truncate(j.events.slice(-8).map((ev) => `${t(ev.at, "t")} ${ev.text}`).join("\n"), 1024) });
  if (j.target.posterUrl) e.setThumbnail(j.target.posterUrl);
  return e;
}

export function logButtons(j: MissingJob): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (j.state === "awaiting_approval") {
    row.addComponents(
      new ButtonBuilder().setCustomId(`msl:approve:${j.id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`msl:deny:${j.id}`).setLabel("Deny").setEmoji("🚫").setStyle(ButtonStyle.Secondary),
    );
  } else if (!ENDED.includes(j.state)) {
    row.addComponents(new ButtonBuilder().setCustomId(`msl:cancel:${j.id}`).setLabel("Cancel").setEmoji("🛑").setStyle(ButtonStyle.Secondary));
  }
  if (!j.bypassLimits) row.addComponents(new ButtonBuilder().setCustomId(`rdl:ban:${j.discordUserId}`).setLabel("Ban requester").setEmoji("🚫").setStyle(ButtonStyle.Danger));
  return row.components.length ? [row] : [];
}
