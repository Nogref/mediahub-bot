/**
 * /report → files a Seerr issue (bad video, audio, subtitles…) for something
 * already in the library. Admins handle it in Seerr as usual; when it's marked
 * resolved the reporter gets a DM (via Seerr's webhook, or a periodic check).
 */
import { MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import { dm, truncate, yearOf } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { IssueType, MediaStatus, type SeerrMediaType, type SeerrSearchResult } from "../services/seerr.js";

const PROBLEMS = [
  { name: "Video (picture, quality, wrong file)", value: "video" },
  { name: "Audio (missing, out of sync, wrong language)", value: "audio" },
  { name: "Subtitles", value: "subtitles" },
  { name: "Something else", value: "other" },
] as const;

const inLibrary = (r: SeerrSearchResult) =>
  (r.mediaType === "movie" || r.mediaType === "tv") &&
  (r.mediaInfo?.status === MediaStatus.AVAILABLE || r.mediaInfo?.status === MediaStatus.PARTIALLY_AVAILABLE);

const label = (r: { title?: string; name?: string; releaseDate?: string; firstAirDate?: string }, type: SeerrMediaType) => {
  const y = yearOf(r.releaseDate ?? r.firstAirDate);
  return `${r.title ?? r.name ?? "Untitled"}${y ? ` (${y})` : ""} · ${type === "movie" ? "Movie" : "Series"}`;
};

export const report: ModuleFactory = ({ services, store, cfg, client, notifier }) => {
  const seerr = services.seerr;
  if (!seerr) return null;
  let timer: NodeJS.Timeout | undefined;

  async function tellReporter(issueId: number) {
    const r = store.closeReport(issueId);
    if (!r) return;
    const sent = await dm(client, r.discordUserId, `✅ The problem you reported with **${r.title}** has been marked fixed. Thanks for flagging it!`);
    if (!sent && cfg.channels.notify) {
      // DMs closed: fall back to a mention in the announcements channel.
      const ch = await client.channels.fetch(cfg.channels.notify).catch(() => null);
      if (ch?.isSendable()) {
        await ch
          .send({ content: `✅ <@${r.discordUserId}> the problem you reported with **${r.title}** has been fixed.`, allowedMentions: { users: [r.discordUserId] } })
          .catch(() => undefined);
      }
    }
  }

  notifier.subscribe((ev) => {
    if (ev.type === "issue" && ev.action === "resolved") void tellReporter(ev.issueId);
  });

  async function autocomplete(i: AutocompleteInteraction) {
    const typed = i.options.getFocused().trim();
    if (typed.length < 2) {
      // Nothing typed yet: suggest what this person recently got.
      const recent = store
        .requestsForUser(i.user.id)
        .done.filter((r) => r.kind !== "album" && r.tmdbId)
        .slice(0, 10)
        .map((r) => ({ name: truncate(`${r.title}${r.year ? ` (${r.year})` : ""} · ${r.kind === "movie" ? "Movie" : "Series"}`, 100), value: `${r.kind}:${r.tmdbId}` }));
      await i.respond(recent);
      return;
    }
    const results = (await seerr!.search(typed)).filter(inLibrary).slice(0, 25);
    await i.respond(results.map((r) => ({ name: truncate(label(r, r.mediaType as SeerrMediaType), 100), value: `${r.mediaType}:${r.id}` })));
  }

  async function execute(i: ChatInputCommandInteraction) {
    const raw = i.options.getString("title", true).trim();
    const problem = i.options.getString("problem", true) as keyof typeof IssueType;
    const details = i.options.getString("details", true).trim();
    const season = i.options.getInteger("season") ?? undefined;
    const episode = i.options.getInteger("episode") ?? undefined;
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    // Picked from autocomplete ("movie:603") or typed freely (search, first title in the library).
    let type: SeerrMediaType;
    let tmdbId: number;
    const m = raw.match(/^(movie|tv):(\d+)$/);
    if (m) {
      type = m[1] as SeerrMediaType;
      tmdbId = Number(m[2]);
    } else {
      const hit = (await seerr!.search(raw)).find(inLibrary);
      if (!hit) {
        await i.editReply(`I couldn't find **${truncate(raw, 80)}** in the library. Pick a title from the suggestions as you type.`);
        return;
      }
      type = hit.mediaType as SeerrMediaType;
      tmdbId = hit.id;
    }

    const d = await seerr!.details(type, tmdbId);
    const title = label(d, type).replace(/ · (Movie|Series)$/, "");
    const mediaId = d.mediaInfo?.id;
    if (!mediaId) {
      await i.editReply(`Seerr doesn't track **${truncate(title, 80)}** as part of the library, so it can't take a report for it.`);
      return;
    }
    if (type === "movie" && (season || episode)) {
      await i.editReply("Season and episode only apply to series. Leave them empty for movies.");
      return;
    }

    const userId = await seerr!.userIdForDiscord(i.user.id);
    const where = season ? ` (S${season}${episode ? `E${episode}` : ""})` : "";
    const message = userId ? details : `${details}\n\n(reported from Discord by ${i.user.username})`;
    const issue = await seerr!.createIssue({ issueType: IssueType[problem], message, mediaId, problemSeason: season, problemEpisode: episode, userId });
    store.addReport({ issueId: issue.id, discordUserId: i.user.id, title, createdAt: Date.now() });

    // Admins hear about it even if Seerr's webhook isn't set up (deduped with it if it is).
    notifier.publish([
      {
        type: "alert",
        source: "Seerr",
        level: "warn",
        title: `New ${problem} issue: ${title}${where}`,
        message: `${truncate(details, 500)}\nReported by <@${i.user.id}>`,
        dedupeKey: `seerr:issue:${issue.id}`,
      },
    ]);

    const link = cfg.seerr?.publicUrl ? `\n${cfg.seerr.publicUrl}/issues/${issue.id}` : "";
    const selfFix =
      (problem === "video" || problem === "audio") && (type === "movie" ? cfg.radarr?.apiKey : cfg.sonarr?.apiKey)
        ? "\n-# Tip: if the file itself is broken, `/redownload start` swaps in a fresh copy without waiting for an admin."
        : "";
    await i.editReply(`📝 Reported **${truncate(title, 80)}**${where} to Seerr (issue #${issue.id}). I'll DM you when it's fixed.${link}${selfFix}`);
    log.info(`report: ${i.user.id} opened Seerr issue #${issue.id} (${problem}) on ${title}`);
  }

  /** Catches resolutions when Seerr's webhook isn't configured. */
  async function sweep() {
    for (const r of store.openReports()) {
      try {
        const issue = await seerr!.getIssue(r.issueId);
        if (issue.status === 2) await tellReporter(r.issueId);
      } catch (err) {
        log.debug(`report: couldn't check issue #${r.issueId}: ${(err as Error).message}`);
      }
    }
  }

  return {
    name: "report",
    commands: [
      {
        name: "report",
        description: "Tell the admins about a problem with something on Plex",
        build: (b) =>
          b
            .addStringOption((o) => o.setName("title").setDescription("Movie or series (start typing)").setRequired(true).setAutocomplete(true))
            .addStringOption((o) =>
              o
                .setName("problem")
                .setDescription("What's wrong")
                .setRequired(true)
                .addChoices(...PROBLEMS.map((p) => ({ name: p.name, value: p.value }))),
            )
            .addStringOption((o) => o.setName("details").setDescription("Describe it, e.g. 'audio is in French from 20:00'").setRequired(true).setMaxLength(500))
            .addIntegerOption((o) => o.setName("season").setDescription("Series only: season number").setMinValue(0).setMaxValue(200))
            .addIntegerOption((o) => o.setName("episode").setDescription("Series only: episode number").setMinValue(1).setMaxValue(2000)),
        execute,
        autocomplete,
      },
    ],
    start: () => {
      const every = Math.max(10, cfg.notify.reconcileMinutes || 10) * 60_000;
      timer = setInterval(() => void sweep(), every);
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
};
