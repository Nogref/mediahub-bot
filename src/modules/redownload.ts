/**
 * /redownload: members replace a broken movie, episode, season or album
 * themselves. The bot picks a different release (or they choose one), the old
 * copy keeps playing until the new one has fully downloaded, and the swap goes
 * through the app's recycling bin. Every step is logged for admins.
 *
 * Members:  /redownload start · status · cancel
 * Admins:   /redownload pause · resume · ban · unban · approvals · history · overview
 *
 * Needs Radarr/Sonarr API keys (and Lidarr for albums). Members must have a
 * Plex account linked with /plex link that's on the server's share list.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { Colors, dm, truncate, ts } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { BotModule, ModuleFactory } from "../core/module.js";
import { TtlCache } from "../core/ttlCache.js";
import { buildAdapters } from "../redownload/arr.js";
import { RedownloadEngine } from "../redownload/engine.js";
import { cancellable, PROBLEMS, STATE_TEXT } from "../redownload/log.js";
import { loadSettings, precheck, quotaUsed, saveSettings } from "../redownload/policy.js";
import { disqualify, fmtSize, pickCandidates, releaseSummary } from "../redownload/select.js";
import { ACTIVE_STATES, RedownloadStore, type Job } from "../redownload/store.js";
import { Library, resolveTarget, TargetError } from "../redownload/targets.js";
import type { CurrentFile, Release, Target } from "../redownload/types.js";
import { plexTvFor } from "../services/plextv.js";

const REVERIFY_MS = 6 * 3_600_000;
const REVERIFY_GRACE_MS = 7 * 86_400_000;
const BIN_CACHE_MS = 5 * 60_000;

interface Session {
  userId: string;
  admin: boolean;
  plexUsername?: string;
  target: Target;
  problem: string;
  details: string;
  oldFiles: CurrentFile[];
  oldGrabs: Array<{ historyId: number; title: string; downloadId?: string; blocklist: boolean }>;
  candidates: Release[];
  chosen: number;
}

const STATE_ICON: Record<string, string> = {
  awaiting_approval: "⏳",
  grabbing: "📡",
  downloading: "⬇️",
  swapping: "🔁",
  importing: "📥",
  needs_admin: "🆘",
  done: "✅",
  failed: "❌",
  cancelled: "🛑",
  denied: "🚫",
};

export const redownload: ModuleFactory = (ctx) => {
  const { cfg, store, client, notifier, access } = ctx;
  const adapters = buildAdapters(cfg);
  if (!adapters.radarr && !adapters.sonarr && !adapters.lidarr) return null;

  const rstore = new RedownloadStore(store);
  const engine = new RedownloadEngine({ adapters, rstore, notifier, client, cfg });
  const library = new Library(adapters);
  const plexTv = plexTvFor(ctx);
  const sessions = new TtlCache<string, Session>(10 * 60_000);
  const bins = new TtlCache<string, string | null>(BIN_CACHE_MS);
  const limits = () => cfg.redownload;

  // ---- gates ----------------------------------------------------------------------
  /** Linked, and that Plex account is (still) on the share list. Re-checked every few hours. */
  async function confirmedPlex(userId: string): Promise<{ ok: true; username: string } | { ok: false; reason: string }> {
    if (!plexTv) return { ok: false, reason: "Redownloads need the bot connected to Plex (PLEX_URL and PLEX_TOKEN) so members can be confirmed. Ask an admin." };
    const l = rstore.link(userId);
    if (!l) {
      return {
        ok: false,
        reason: "🔗 First, link your Plex account with `/plex link`. It's a one-time sign-in so I know you're on the server.",
      };
    }
    if (Date.now() - l.verifiedAt > REVERIFY_MS) {
      try {
        l.hasAccess = await plexTv.hasAccess(l.plexUserId);
        rstore.setVerified(userId, l.hasAccess);
      } catch (err) {
        log.warn(`redownload: couldn't re-check Plex access for ${userId}: ${(err as Error).message}`);
        if (Date.now() - l.verifiedAt > REVERIFY_GRACE_MS) return { ok: false, reason: "I couldn't reach Plex to confirm your access. Try again in a few minutes." };
      }
    }
    if (!l.hasAccess) {
      return {
        ok: false,
        reason: `Your linked Plex account (**${l.plexUsername}**) isn't on this server's share list any more, so redownloads are locked. Ask an admin if that's wrong.`,
      };
    }
    return { ok: true, username: l.plexUsername };
  }

  async function recycleBin(app: Target["app"]): Promise<string | null> {
    const hit = bins.get(app);
    if (hit !== undefined) return hit;
    const bin = (await adapters[app]!.recycleBin()) ?? null;
    if (bin) bins.set(app, bin); // only remember "it's set", so fixing it takes effect immediately
    return bin;
  }

  const who = (i: { user: { id: string } } & Parameters<typeof access.isAdmin>[0]) => ({ id: i.user.id, admin: access.isAdmin(i) });

  // ---- /redownload start ------------------------------------------------------------
  async function start(i: ChatInputCommandInteraction) {
    const pick = i.options.getString("title", true).trim();
    const problem = i.options.getString("problem", true);
    const details = i.options.getString("details", true).trim();
    const season = i.options.getInteger("season") ?? undefined;
    const episode = i.options.getInteger("episode") ?? undefined;
    const me = who(i);
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    if (details.length < 10) return void (await i.editReply("Please describe the problem in a few more words (what you saw, and roughly when)."));
    if (episode !== undefined && season === undefined) return void (await i.editReply("Add the **season** too, so I know which episode you mean."));

    let plexUsername: string | undefined;
    if (!me.admin) {
      const s = loadSettings(store);
      if (s.paused) return void (await i.editReply(`⏸️ Redownloads are paused by an admin${s.paused.reason ? `: ${s.paused.reason}` : ""}. Try again later.`));
      const p = await confirmedPlex(i.user.id);
      if (!p.ok) return void (await i.editReply(p.reason));
      plexUsername = p.username;
    } else {
      plexUsername = rstore.link(i.user.id)?.plexUsername;
    }

    // Typed without picking a suggestion: accept it when it matches exactly one title.
    let value = pick;
    if (!/^[msa]:\d+$/.test(pick)) {
      const hits = await library.search(pick, 2);
      if (hits.length !== 1) {
        return void (await i.editReply(
          hits.length ? `More than one title matches **${truncate(pick, 60)}**. Pick one from the suggestions as you type.` : `I couldn't find **${truncate(pick, 60)}** in the library. Pick a title from the suggestions as you type.`,
        ));
      }
      value = hits[0].value;
    }

    let target: Target;
    try {
      target = await resolveTarget(adapters, value, season, episode);
    } catch (err) {
      if (err instanceof TargetError) return void (await i.editReply(err.message));
      throw err;
    }
    const a = adapters[target.app]!;

    // The safety net is mandatory: without a recycling bin the app deletes files permanently.
    if (!(await recycleBin(target.app))) {
      log.warn(`redownload: ${a.name} has no recycling bin set; refusing redownloads for it`);
      return void (await i.editReply(
        me.admin
          ? `🛑 ${a.name} has no **Recycling Bin** set, and redownloads won't delete anything without one. Set it in ${a.name} → Settings → Media Management → File Management (show advanced), then try again.`
          : `Redownloads for this kind of title aren't fully set up yet (an admin needs to switch on ${a.name}'s recycling bin). Use \`/report\` for now.`,
      ));
    }

    const blocked = precheck(rstore, loadSettings(store), limits(), me, target);
    if (blocked) return void (await i.editReply(blocked));

    await i.editReply(`🔎 Looking for a fresh copy of **${truncate(target.label, 80)}**…`);
    const [oldFiles, releases] = await Promise.all([a.currentFiles(target), a.search(target)]);
    const oldGrabs = await a.currentGrabs(target, oldFiles);
    if (!oldFiles.length) return void (await i.editReply(`**${target.label}** has no files on disk right now, so there's nothing to replace. If it's missing, request it again.`));

    const opts = {
      kind: target.kind,
      excludeTitles: [...oldFiles.map((f) => f.releaseTitle ?? ""), ...oldGrabs.map((g) => g.title)].filter(Boolean),
      currentSize: oldFiles.reduce((s, f) => s + f.size, 0),
    };
    const candidates = pickCandidates(releases, opts);
    if (!candidates.length) {
      const reasons = new Map<string, number>();
      for (const r of releases) {
        const why = disqualify(r, opts) ?? "";
        reasons.set(why, (reasons.get(why) ?? 0) + 1);
      }
      const top = [...reasons.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([why, n]) => `${n}× ${truncate(why, 80)}`);
      log.info(`redownload: no usable release for ${target.label} (${releases.length} found: ${top.join("; ")})`);
      return void (await i.editReply(
        `😕 I couldn't find a usable replacement for **${target.label}** right now ` +
          `(${releases.length ? `${releases.length} release${releases.length === 1 ? "" : "s"} found, none suitable` : "the indexers returned nothing"}). ` +
          `Nothing was changed and it didn't use a redownload. Try again later, or use \`/report\` so an admin can look.` +
          (me.admin && top.length ? `\n-# Admin: ${top.join(" · ")}` : ""),
      ));
    }

    const sid = randomBytes(6).toString("hex");
    const s: Session = { userId: i.user.id, admin: me.admin, plexUsername, target, problem, details, oldFiles, oldGrabs, candidates, chosen: 0 };
    sessions.set(sid, s);
    await i.editReply(card(sid, s));
  }

  function card(sid: string, s: Session) {
    const r = s.candidates[s.chosen];
    const oldSize = s.oldFiles.reduce((a, f) => a + f.size, 0);
    const now =
      s.oldFiles.length === 1 ? `${s.oldFiles[0].quality} · ${fmtSize(oldSize)}` : `${s.oldFiles.length} files · ${fmtSize(oldSize)} · ${[...new Set(s.oldFiles.map((f) => f.quality))].join(", ")}`;
    const settings = loadSettings(store);
    const { used } = quotaUsed(rstore, s.userId);
    const lim = limits();
    const cost = s.admin
      ? "Admin: no limits."
      : `Uses **${s.target.weight}** of your ${lim.dailyLimit} redownloads for the next 24 hours (${used} used). It's refunded if nothing gets replaced.`;
    const e = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle(truncate(`🔁 Replace ${s.target.label}?`, 256))
      .setDescription(
        `**Problem:** ${PROBLEMS[s.problem] ?? s.problem}\n> ${truncate(s.details, 300)}\n\n` +
          `Your current copy keeps playing until the new one has fully downloaded. Then the old file goes to the recycling bin and the new one takes its place. ` +
          `If a download fails, I'll try up to ${lim.maxAttempts - 1} other release${lim.maxAttempts - 1 === 1 ? "" : "s"}.` +
          (settings.approvals && !s.admin ? "\n\n⏳ An admin will need to approve it first." : ""),
      )
      .addFields(
        { name: "On Plex now", value: now, inline: true },
        { name: s.chosen === 0 ? "Replacement (best match)" : "Replacement (your pick)", value: truncate(`${releaseSummary(r)}\n\`${r.title}\``, 1024), inline: true },
      )
      .setFooter({ text: cost.replace(/\*\*/g, "") });
    if (s.target.posterUrl) e.setThumbnail(s.target.posterUrl);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rdc:go:${sid}`).setLabel(settings.approvals && !s.admin ? "Ask for approval" : "Replace it").setEmoji("🔁").setStyle(ButtonStyle.Success),
    );
    if (s.candidates.length > 1) row.addComponents(new ButtonBuilder().setCustomId(`rdc:pick:${sid}`).setLabel("Pick a different release").setStyle(ButtonStyle.Secondary));
    row.addComponents(new ButtonBuilder().setCustomId(`rdc:x:${sid}`).setLabel("Never mind").setStyle(ButtonStyle.Secondary));
    return { content: "", embeds: [e], components: [row] };
  }

  function picker(sid: string, s: Session) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rdc:sel:${sid}`)
      .setPlaceholder("Choose a release")
      .addOptions(
        s.candidates.slice(0, 25).map((r, idx) => ({
          label: truncate(`${idx === 0 ? "★ " : ""}${releaseSummary(r)}`, 100),
          description: truncate(r.title, 100),
          value: String(idx),
          default: idx === s.chosen,
        })),
      );
    return {
      content: "Pick the release to download instead. ★ is the one I'd choose. Higher quality first; for torrents, more seeders means a faster, safer download.",
      embeds: [],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`rdc:back:${sid}`).setLabel("Back").setStyle(ButtonStyle.Secondary)),
      ],
    };
  }

  async function onCard(i: MessageComponentInteraction) {
    const [, action, sid] = i.customId.split(":");
    const s = sessions.get(sid);
    if (!s) return void (await i.update({ content: "⌛ That expired. Run `/redownload start` again.", embeds: [], components: [] }));
    if (s.userId !== i.user.id) return void (await i.reply({ content: "That isn't yours.", flags: MessageFlags.Ephemeral }));

    if (action === "x") {
      sessions.delete(sid);
      return void (await i.update({ content: "👍 Okay, nothing was changed.", embeds: [], components: [] }));
    }
    if (action === "pick") return void (await i.update(picker(sid, s)));
    if (action === "back") return void (await i.update(card(sid, s)));
    if (action === "sel" && i.isStringSelectMenu()) {
      const idx = Number(i.values[0]);
      if (Number.isInteger(idx) && idx >= 0 && idx < s.candidates.length) s.chosen = idx;
      return void (await i.update(card(sid, s)));
    }
    if (action !== "go") return;

    // Everything below runs without awaiting until the job exists, so two clicks can't double-book.
    const me = { id: s.userId, admin: s.admin };
    const settings = loadSettings(store);
    const blocked = precheck(rstore, settings, limits(), me, s.target);
    if (blocked) {
      sessions.delete(sid);
      return void (await i.update({ content: blocked, embeds: [], components: [] }));
    }
    sessions.delete(sid);
    const chosen = s.candidates[s.chosen];
    const needsApproval = settings.approvals && !s.admin;
    const job = rstore.createJob({
      discordUserId: s.userId,
      plexUsername: s.plexUsername,
      target: s.target,
      problem: s.problem,
      details: s.details,
      state: needsApproval ? "awaiting_approval" : "grabbing",
      candidates: [chosen, ...s.candidates.filter((_, idx) => idx !== s.chosen)],
      oldFiles: s.oldFiles,
      oldGrabs: s.oldGrabs,
      bypassLimits: s.admin,
      events: [{ at: Date.now(), text: `🙋 Requested by <@${s.userId}>${s.chosen === 0 ? "" : " (picked the release)"}` }],
    });
    log.info(`redownload #${job.id}: ${s.userId} (${s.plexUsername ?? "no plex"}) → ${s.target.label} [${s.problem}] ${truncate(s.details, 120)}`);

    await i.update({
      content: needsApproval
        ? `📨 Sent to the admins for approval (redownload #${job.id}). I'll DM you once it's decided. Your current copy is untouched.`
        : `✅ On it! Redownload #${job.id} has started. Your current copy keeps working until the new one is ready, and I'll DM you when it's done. Check on it with \`/redownload status\`.`,
      embeds: [],
      components: [],
    });
    await engine.updateLog(job);
    if (!needsApproval) void engine.tick(job.id);
  }

  // ---- log buttons (admins) -------------------------------------------------------------
  async function onLog(i: MessageComponentInteraction) {
    const [, action, arg] = i.customId.split(":");
    if (!access.isAdmin(i)) return void (await i.reply({ content: "🔒 Only admins can use these buttons.", flags: MessageFlags.Ephemeral }));

    if (action === "ban") {
      const settings = loadSettings(store);
      settings.banned[arg] = { by: i.user.id, reason: "banned from the redownload log", at: Date.now() };
      saveSettings(store, settings);
      let denied = 0;
      for (const j of rstore.activeJobs().filter((j) => j.discordUserId === arg && j.state === "awaiting_approval")) {
        await engine.deny(j.id, i.user.id, "The requester was banned from redownloads.");
        denied++;
      }
      log.info(`redownload: ${i.user.id} banned ${arg}`);
      return void (await i.reply({
        content: `🚫 <@${arg}> can no longer use redownloads${denied ? ` (and ${denied} waiting request${denied === 1 ? " was" : "s were"} denied)` : ""}. Anything already running keeps going; use its Cancel button to stop it. Undo with \`/redownload unban\`.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      }));
    }

    const job = rstore.job(Number(arg));
    if (!job) return void (await i.reply({ content: "I can't find that redownload any more.", flags: MessageFlags.Ephemeral }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let msg: string;
    if (action === "approve") {
      if (job.state === "awaiting_approval") {
        await dm(client, job.discordUserId, `👍 Your redownload of **${job.target.label}** was approved and is on its way. Your current copy keeps working until the new one is ready.`);
      }
      msg = await engine.approve(job.id, i.user.id);
    } else if (action === "deny") {
      msg = await engine.deny(job.id, i.user.id);
    } else if (action === "cancel") {
      msg = await engine.cancel(job.id, i.user.id);
    } else if (action === "resolve") {
      msg = await engine.resolve(job.id, i.user.id);
    } else msg = "Unknown action.";
    await i.editReply(msg);
  }

  // ---- member: status / cancel ---------------------------------------------------------
  function jobLine(j: Job, withUser = false): string {
    const link = j.logChannelId && j.logMessageId && withUser ? ` · [log](https://discord.com/channels/${cfg.guildId}/${j.logChannelId}/${j.logMessageId})` : "";
    return `${STATE_ICON[j.state] ?? "•"} **#${j.id}** ${truncate(j.target.label, 60)}${withUser ? ` · <@${j.discordUserId}>` : ""} · ${ts(j.finishedAt ?? j.updatedAt)}${link}`;
  }

  async function status(i: ChatInputCommandInteraction) {
    const me = who(i);
    const lim = limits();
    const mine = rstore.recentJobs(10, i.user.id);
    const active = mine.filter((j) => ACTIVE_STATES.includes(j.state));
    const { used, nextFreeAt } = quotaUsed(rstore, i.user.id);
    const link = rstore.link(i.user.id);
    const settings = loadSettings(store);
    const lines = [
      me.admin
        ? "**Redownloads left:** unlimited (admin)"
        : `**Redownloads left:** ${Math.max(0, lim.dailyLimit - used)} of ${lim.dailyLimit}${used && nextFreeAt ? ` · next one frees up ${ts(nextFreeAt)}` : ""}`,
      `**Plex account:** ${link ? `${link.plexUsername} ${link.hasAccess ? "✅" : "❌ not on the share list"}` : "not linked. Run `/plex link`"}`,
    ];
    if (settings.paused) lines.push("⏸️ Redownloads are paused right now.");
    if (settings.banned[i.user.id]) lines.push("🚫 You can't start redownloads right now.");
    const e = new EmbedBuilder().setColor(Colors.info).setTitle("🔁 Your redownloads").setDescription(lines.join("\n"));
    if (active.length) e.addFields({ name: "In progress", value: truncate(active.map((j) => `${jobLine(j)}\n${STATE_TEXT[j.state]}${j.progress !== undefined && j.state === "downloading" ? ` (${j.progress}%)` : ""}`).join("\n"), 1024) });
    const past = mine.filter((j) => !ACTIVE_STATES.includes(j.state)).slice(0, 6);
    if (past.length) e.addFields({ name: "Recent", value: truncate(past.map((j) => jobLine(j)).join("\n"), 1024) });
    if (!mine.length) e.addFields({ name: "How it works", value: "If something on Plex is broken (glitchy video, bad audio, wrong file), run `/redownload start` and I'll swap in a fresh copy." });
    await i.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
  }

  async function cancel(i: ChatInputCommandInteraction) {
    const id = i.options.getInteger("job", true);
    const job = rstore.job(id);
    const admin = access.isAdmin(i);
    if (!job || (job.discordUserId !== i.user.id && !admin)) return void (await i.reply({ content: `I can't find a redownload #${id} of yours.`, flags: MessageFlags.Ephemeral }));
    if (!cancellable(job)) return void (await i.reply({ content: `#${id} can't be cancelled now: ${STATE_TEXT[job.state].replace(/^\S+\s/, "").toLowerCase()}.`, flags: MessageFlags.Ephemeral }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await i.editReply(await engine.cancel(job.id, i.user.id));
  }

  async function jobAutocomplete(i: AutocompleteInteraction) {
    const admin = access.isAdmin(i);
    const jobs = rstore.activeJobs().filter((j) => cancellable(j) && (admin || j.discordUserId === i.user.id));
    await i.respond(jobs.slice(0, 25).map((j) => ({ name: truncate(`#${j.id} ${j.target.label} (${j.state.replace("_", " ")})`, 100), value: j.id })));
  }

  async function titleAutocomplete(i: AutocompleteInteraction) {
    const typed = i.options.getFocused().trim();
    await i.respond(await library.search(typed));
  }

  // ---- admin ------------------------------------------------------------------------------
  const ADMIN = { gate: "admin" as const };
  const update = (fn: (s: ReturnType<typeof loadSettings>) => void) => {
    const s = loadSettings(store);
    fn(s);
    saveSettings(store, s);
  };

  async function overview(i: ChatInputCommandInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const s = loadSettings(store);
    const lim = limits();
    bins.delete("radarr");
    bins.delete("sonarr");
    bins.delete("lidarr");
    const apps = await Promise.all(
      (["radarr", "sonarr", "lidarr"] as const).map(async (app) => {
        const a = adapters[app];
        if (!a) return `▫️ ${app[0].toUpperCase()}${app.slice(1)}: not set up${app === "lidarr" ? "" : " (needs an API key)"}`;
        try {
          const bin = await recycleBin(app);
          return bin ? `✅ ${a.name}: recycling bin \`${bin}\`` : `🛑 ${a.name}: **no recycling bin**, so redownloads are blocked for it`;
        } catch (err) {
          return `⚠️ ${a.name}: ${truncate((err as Error).message, 80)}`;
        }
      }),
    );
    const active = rstore.activeJobs();
    const logCh = cfg.channels.redownloadLog ?? cfg.channels.admin;
    const banned = Object.entries(s.banned);
    const e = new EmbedBuilder()
      .setColor(s.paused ? Colors.warn : Colors.info)
      .setTitle("🔁 Redownloads")
      .setDescription(
        [
          s.paused ? `⏸️ **Paused** by <@${s.paused.by}> ${ts(s.paused.at)}${s.paused.reason ? `: ${s.paused.reason}` : ""}` : "▶️ Open to linked members",
          `Approve first: **${s.approvals ? "on" : "off"}**`,
          `Limits: ${lim.dailyLimit} per member per 24h (a season counts 2) · ${lim.titleCooldownHours}h cooldown per title · ${lim.maxActive} at once · ${lim.maxAttempts} releases tried`,
          `Log channel: ${logCh ? `<#${logCh}>` : "⚠️ none set, so redownloads are only in the container log (use `/setup channels redownload_log:`)"}`,
          `Plex linking: ${plexTv ? `${rstore.links().length} member(s) linked` : "off (needs PLEX_URL and PLEX_TOKEN)"}`,
        ].join("\n"),
      )
      .addFields({ name: "Apps", value: apps.join("\n") });
    if (active.length) e.addFields({ name: `Active (${active.length})`, value: truncate(active.map((j) => jobLine(j, true)).join("\n"), 1024) });
    if (banned.length) e.addFields({ name: `Banned (${banned.length})`, value: truncate(banned.map(([id, b]) => `<@${id}>${b.reason ? `: ${b.reason}` : ""}`).join("\n"), 1024) });
    await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
  }

  async function history(i: ChatInputCommandInteraction) {
    const u = i.options.getUser("user") ?? undefined;
    const jobs = rstore.recentJobs(20, u?.id);
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.info)
          .setTitle(u ? `🔁 Redownloads by ${u.username}` : "🔁 Recent redownloads")
          .setDescription(truncate(jobs.map((j) => `${jobLine(j, true)}\n-# ${PROBLEMS[j.problem] ?? j.problem}: ${truncate(j.details, 90)}`).join("\n") || "None yet.", 4000)),
      ],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  const PARENT = { parent: "redownload", parentDescription: "Replace something broken on Plex with a fresh copy" } as const;

  const mod: BotModule & { engine: RedownloadEngine; rstore: RedownloadStore } = {
    engine, // exposed for tests
    rstore,
    name: "redownload",
    subcommands: [
      {
        ...PARENT,
        name: "start",
        description: "Replace a broken movie, episode, season or album with a fresh copy",
        build: (b) =>
          b
            .addStringOption((o) => o.setName("title").setDescription("Movie, series or album (start typing)").setRequired(true).setAutocomplete(true))
            .addStringOption((o) =>
              o
                .setName("problem")
                .setDescription("What's wrong with it")
                .setRequired(true)
                .addChoices(...Object.entries(PROBLEMS).map(([value, name]) => ({ name, value }))),
            )
            .addStringOption((o) =>
              o.setName("details").setDescription("Describe it, e.g. 'picture freezes at 41:00'").setRequired(true).setMinLength(10).setMaxLength(300),
            )
            .addIntegerOption((o) => o.setName("season").setDescription("Series: season number (required for series)").setMinValue(0).setMaxValue(200))
            .addIntegerOption((o) => o.setName("episode").setDescription("Series: episode number (leave empty to replace the whole season)").setMinValue(1).setMaxValue(2000)),
        execute: start,
        autocomplete: titleAutocomplete,
      },
      { ...PARENT, name: "status", description: "Your redownloads and how many you have left", execute: status },
      {
        ...PARENT,
        name: "cancel",
        description: "Stop a redownload before anything is replaced",
        build: (b) => b.addIntegerOption((o) => o.setName("job").setDescription("Which one").setRequired(true).setAutocomplete(true)),
        execute: cancel,
        autocomplete: jobAutocomplete,
      },
      {
        ...PARENT,
        ...ADMIN,
        name: "pause",
        description: "Admin: stop members starting redownloads",
        build: (b) => b.addStringOption((o) => o.setName("reason").setDescription("Shown to members").setMaxLength(200)),
        execute: async (i) => {
          const reason = i.options.getString("reason") ?? undefined;
          update((s) => (s.paused = { by: i.user.id, reason, at: Date.now() }));
          log.info(`redownload: paused by ${i.user.id}${reason ? ` (${reason})` : ""}`);
          await i.reply({ content: "⏸️ Paused. Members can't start new redownloads; ones already running will finish. `/redownload resume` to reopen.", flags: MessageFlags.Ephemeral });
        },
      },
      {
        ...PARENT,
        ...ADMIN,
        name: "resume",
        description: "Admin: let members start redownloads again",
        execute: async (i) => {
          update((s) => delete s.paused);
          log.info(`redownload: resumed by ${i.user.id}`);
          await i.reply({ content: "▶️ Redownloads are open again.", flags: MessageFlags.Ephemeral });
        },
      },
      {
        ...PARENT,
        ...ADMIN,
        name: "ban",
        description: "Admin: stop a member using redownloads",
        build: (b) =>
          b
            .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
            .addStringOption((o) => o.setName("reason").setDescription("Shown to them when they try").setMaxLength(200)),
        execute: async (i) => {
          const u = i.options.getUser("user", true);
          const reason = i.options.getString("reason") ?? undefined;
          update((s) => (s.banned[u.id] = { by: i.user.id, reason, at: Date.now() }));
          log.info(`redownload: ${i.user.id} banned ${u.id}${reason ? ` (${reason})` : ""}`);
          await i.reply({ content: `🚫 <@${u.id}> can no longer start redownloads.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        },
      },
      {
        ...PARENT,
        ...ADMIN,
        name: "unban",
        description: "Admin: let a member use redownloads again",
        build: (b) => b.addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
        execute: async (i) => {
          const u = i.options.getUser("user", true);
          update((s) => delete s.banned[u.id]);
          log.info(`redownload: ${i.user.id} unbanned ${u.id}`);
          await i.reply({ content: `✅ <@${u.id}> can use redownloads again.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        },
      },
      {
        ...PARENT,
        ...ADMIN,
        name: "approvals",
        description: "Admin: require an admin to approve each redownload",
        build: (b) =>
          b.addStringOption((o) =>
            o
              .setName("mode")
              .setDescription("On: admins approve each one first. Off: they start straight away")
              .setRequired(true)
              .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" }),
          ),
        execute: async (i) => {
          const on = i.options.getString("mode", true) === "on";
          update((s) => (s.approvals = on));
          log.info(`redownload: approvals ${on ? "on" : "off"} (${i.user.id})`);
          await i.reply({
            content: on ? "⏳ Approve-first is **on**. New redownloads wait for an Approve click in the log channel (auto-denied after 24h)." : "▶️ Approve-first is **off**. Redownloads start straight away.",
            flags: MessageFlags.Ephemeral,
          });
        },
      },
      {
        ...PARENT,
        ...ADMIN,
        name: "history",
        description: "Admin: recent redownloads",
        build: (b) => b.addUserOption((o) => o.setName("user").setDescription("Only this member")),
        execute: history,
      },
      { ...PARENT, ...ADMIN, name: "overview", description: "Admin: settings, safety checks and what's running", execute: overview },
    ],
    components: { rdc: onCard, rdl: onLog },
    start: () => {
      engine.start();
      const pending = rstore.activeJobs().length;
      if (pending) log.info(`redownload: resuming ${pending} job(s) from before the restart`);
    },
    stop: () => engine.stop(),
  };
  return mod;
};

