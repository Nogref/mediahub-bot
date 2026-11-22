/** The admin log entry for one redownload: a single message, edited as it progresses. */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { Colors, truncate } from "../core/discord.js";
import { fmtSize, releaseSummary } from "./select.js";
import type { Job, JobState } from "./store.js";

export const STATE_TEXT: Record<JobState, string> = {
  awaiting_approval: "⏳ Waiting for an admin to approve",
  grabbing: "📡 Sending the replacement to the downloader",
  downloading: "⬇️ Downloading. The old copy is still playing",
  swapping: "🔁 Download finished. Swapping files",
  importing: "📥 Old copy moved to the recycling bin. Importing the new one",
  needs_admin: "🆘 Needs an admin",
  done: "✅ Replaced",
  failed: "❌ Couldn't replace it. The original is untouched",
  cancelled: "🛑 Cancelled",
  denied: "🚫 Denied",
};

const COLOR: Partial<Record<JobState, number>> = {
  awaiting_approval: Colors.warn,
  needs_admin: Colors.bad,
  done: Colors.ok,
  failed: Colors.bad,
  cancelled: Colors.muted,
  denied: Colors.muted,
};

export const PROBLEMS: Record<string, string> = {
  video: "Corrupt or glitchy video",
  audio: "Audio missing or out of sync",
  wrong: "Wrong movie/episode/album",
  quality: "Bad quality",
  other: "Something else",
};

export function cancellable(j: Job): boolean {
  return j.state === "awaiting_approval" || j.state === "grabbing" || j.state === "downloading";
}

export function logEmbed(j: Job): EmbedBuilder {
  const old = j.oldFiles.length === 1 ? j.oldFiles[0] : undefined;
  const oldText = old
    ? `${old.quality} · ${fmtSize(old.size)}${old.releaseTitle ? `\n\`${truncate(old.releaseTitle.split(/[\\/]/).pop(), 120)}\`` : ""}`
    : `${j.oldFiles.length} files · ${fmtSize(j.oldFiles.reduce((a, f) => a + f.size, 0))}`;
  const e = new EmbedBuilder()
    .setColor(COLOR[j.state] ?? Colors.info)
    .setTitle(truncate(`🔁 Redownload #${j.id} · ${j.target.label}`, 256))
    .setDescription(`**${STATE_TEXT[j.state]}**${j.progress !== undefined && j.state === "downloading" ? ` (${j.progress}%)` : ""}${j.outcome ? `\n${j.outcome}` : ""}`)
    .addFields(
      { name: "Requested by", value: `<@${j.discordUserId}>${j.plexUsername ? ` · Plex: ${j.plexUsername}` : ""}${j.bypassLimits ? " · admin" : ""}`, inline: false },
      { name: "Reason", value: truncate(`${PROBLEMS[j.problem] ?? j.problem}${j.details ? `: ${j.details}` : " (no details given)"}`, 1024) },
      { name: "Replacing", value: truncate(oldText, 1024), inline: true },
    )
    .setFooter({ text: `${j.target.app} · attempt ${Math.max(j.attempt, 1)} · id ${j.id}` })
    .setTimestamp(new Date(j.updatedAt));
  if (j.current) e.addFields({ name: "With", value: truncate(`${releaseSummary(j.current)}\n\`${j.current.title}\``, 1024), inline: true });
  if (j.events.length) {
    e.addFields({ name: "Timeline", value: truncate(j.events.slice(-8).map((ev) => `<t:${Math.floor(ev.at / 1000)}:t> ${ev.text}`).join("\n"), 1024) });
  }
  if (j.target.posterUrl) e.setThumbnail(j.target.posterUrl);
  return e;
}

export function logButtons(j: Job): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (j.state === "awaiting_approval") {
    row.addComponents(
      new ButtonBuilder().setCustomId(`rdl:approve:${j.id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rdl:deny:${j.id}`).setLabel("Deny").setEmoji("🚫").setStyle(ButtonStyle.Secondary),
    );
  } else if (j.state === "needs_admin") {
    row.addComponents(new ButtonBuilder().setCustomId(`rdl:resolve:${j.id}`).setLabel("Mark resolved").setEmoji("🧰").setStyle(ButtonStyle.Secondary));
  } else if (cancellable(j)) {
    row.addComponents(new ButtonBuilder().setCustomId(`rdl:cancel:${j.id}`).setLabel("Cancel").setEmoji("🛑").setStyle(ButtonStyle.Secondary));
  }
  if (!j.bypassLimits) {
    row.addComponents(new ButtonBuilder().setCustomId(`rdl:ban:${j.discordUserId}`).setLabel("Ban requester").setEmoji("🚫").setStyle(ButtonStyle.Danger));
  }
  return row.components.length ? [row] : [];
}
