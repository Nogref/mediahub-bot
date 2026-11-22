/**
 * /redownload: members replace a broken movie, episode, season or album
 * themselves. The bot picks a different release (or they choose one), the old
 * copy keeps playing until the new one has fully downloaded, and the swap goes
 * through the app's recycling bin. Every step is logged for admins.
 *
 * Members:  /redownload start · status (cancel and refresh are buttons on their tracker)
 * Admins:   /admin redownloads overview · history · pause · resume · ban · unban · approvals · plexcheck
 *
 * Needs Radarr/Sonarr API keys (and Lidarr for albums). Open to every member
 * of the Discord server by default; `/admin redownloads plexcheck` limits it to
 * members with a linked Plex account (/plex) on the server's share list.
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
import { dmFallbackChannel } from "../notify/announce.js";
import { TtlCache } from "../core/ttlCache.js";
import { buildAdapters } from "../redownload/arr.js";
import { RedownloadEngine } from "../redownload/engine.js";
import { cancellable, PROBLEMS } from "../redownload/log.js";
import { friendlyQuality, friendlyRelease, friendlySize, Tracker, trackerEmbed, trackerPayload } from "../redownload/tracker.js";
import { loadSettings, precheck, quotaUsed, saveSettings } from "../redownload/policy.js";
import { disqualify, pickCandidates } from "../redownload/select.js";
import { ACTIVE_STATES, RedownloadStore, type Job } from "../redownload/store.js";
import { Library, resolveTarget, TargetError } from "../redownload/targets.js";
import type { CurrentFile, Release, Target } from "../redownload/types.js";
import { plexTvFor } from "../services/plextv.js";
import { MissingStore } from "../missing/store.js";
import { confirmedPlex as checkPlex } from "../redownload/gate.js";
import { ADMIN } from "./parents.js";

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
  const tracker = new Tracker(client, rstore);
  const engine = new RedownloadEngine({ adapters, rstore, notifier, client, cfg, tracker, fallbackChannel: () => dmFallbackChannel(store, cfg.channels.notify) });
  const library = new Library(adapters);
  const plexTv = plexTvFor(ctx);
  const sessions = new TtlCache<string, Session>(10 * 60_000);
  const bins = new TtlCache<string, string | null>(BIN_CACHE_MS);
  const limits = () => cfg.redownload;

  // ---- gates ----------------------------------------------------------------------
  const confirmedPlex = (userId: string) => checkPlex(rstore, plexTv, userId);

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
    const details = i.options.getString("details")?.trim() ?? "";
    const season = i.options.getInteger("season") ?? undefined;
    const episode = i.options.getInteger("episode") ?? undefined;
    const me = who(i);
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    if (episode !== undefined && season === undefined) return void (await i.editReply("Add the **season** too, so I know which episode you mean."));

    let plexUsername: string | undefined;
    if (!me.admin) {
      const s = loadSettings(store);
      if (s.paused) return void (await i.editReply(`⏸️ Redownloads are paused by an admin${s.paused.reason ? `: ${s.paused.reason}` : ""}. Try again later.`));
      if (s.requirePlex) {
        const p = await confirmedPlex(i.user.id);
        if (!p.ok) return void (await i.editReply(p.reason));
        plexUsername = p.username;
      } else {
        plexUsername = rstore.link(i.user.id)?.plexUsername; // shown in the log when they've linked anyway
      }
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
          : "Redownloads for this aren't fully set up yet, so an admin needs to finish that first. Use `/report` for now.",
      ));
    }

    const blocked = precheck(rstore, loadSettings(store), limits(), me, target);
    if (blocked) return void (await i.editReply(blocked));

    await i.editReply(`🔎 Looking for a fresh copy of **${truncate(target.label, 80)}**… this can take up to a minute.`);
    const [oldFiles, releases] = await Promise.all([a.currentFiles(target), a.search(target)]);
    const oldGrabs = await a.currentGrabs(target, oldFiles);
    if (!oldFiles.length) return void (await i.editReply(`**${target.label}** isn't on Plex right now, so there's nothing to replace. If it's missing, request it again with \`/request\`.`));

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
        `😕 I couldn't find another copy of **${target.label}** that's safe to use right now. ` +
          `Nothing was changed and it didn't count toward your daily limit. Try again in a day or two, or use \`/report\` so an admin can look.` +
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
    const qualities = [...new Set(s.oldFiles.map((f) => friendlyQuality(f.quality)))].join(", ");
    const now = s.oldFiles.length === 1 ? `${qualities} · ${friendlySize(oldSize)}` : `${s.oldFiles.length} files · ${qualities} · ${friendlySize(oldSize)}`;
    const settings = loadSettings(store);
    const { used } = quotaUsed(rstore, s.userId);
    const lim = limits();
    const cost = s.admin
      ? "Admin: no limits."
      : `This uses ${s.target.weight} of your ${lim.dailyLimit} redownloads for the next 24 hours (${used} used so far). You get it back if nothing ends up being replaced.`;
    const e = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle(truncate(`🔁 Replace ${s.target.label}?`, 256))
      .setDescription(
        `**Problem:** ${PROBLEMS[s.problem] ?? s.problem}${s.details ? `\n> ${truncate(s.details, 300)}` : ""}\n\n` +
          "**What happens next:** I download the new copy while your current one keeps working. When it's ready, I swap it in (the old one is kept as a backup). " +
          "I'll keep you posted in your DMs the whole way." +
          (settings.approvals && !s.admin ? "\n\n⏳ An admin will need to OK it first." : ""),
      )
      .addFields(
        { name: "On Plex now", value: now, inline: true },
        { name: s.chosen === 0 ? "New copy (my pick)" : "New copy (your pick)", value: truncate(`${friendlyRelease(r)}\n-# ${r.title}`, 1024), inline: true },
      )
      .setFooter({ text: cost });
    if (s.target.posterUrl) e.setThumbnail(s.target.posterUrl);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rdc:go:${sid}`).setLabel(settings.approvals && !s.admin ? "Ask an admin" : "Replace it").setEmoji("🔁").setStyle(ButtonStyle.Success),
    );
    if (s.candidates.length > 1) row.addComponents(new ButtonBuilder().setCustomId(`rdc:pick:${sid}`).setLabel("Choose a different copy").setStyle(ButtonStyle.Secondary));
    row.addComponents(new ButtonBuilder().setCustomId(`rdc:x:${sid}`).setLabel("Never mind").setStyle(ButtonStyle.Secondary));
    return { content: "", embeds: [e], components: [row] };
  }

  function picker(sid: string, s: Session) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rdc:sel:${sid}`)
      .setPlaceholder("Choose a copy")
      .addOptions(
        s.candidates.slice(0, 25).map((r, idx) => ({
          label: truncate(`${idx === 0 ? "★ " : ""}${friendlyRelease(r)}`, 100),
          description: truncate(r.title, 100),
          value: String(idx),
          default: idx === s.chosen,
        })),
      );
    return {
      content:
        'Pick which copy to download instead. ★ is the one I\'d choose.\n-# Best quality first. "May be slow" ones can take a long time to download. Not sure? Stick with ★.',
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
    log.info(`redownload #${job.id}: ${s.userId} (${s.plexUsername ?? "no plex"}) → ${s.target.label} [${s.problem}]${s.details ? ` ${truncate(s.details, 120)}` : ""}`);

    // Acknowledge first (Discord wants an answer within 3 seconds), then send the tracker.
    await i.deferUpdate();
    const dmOk = await tracker.start(job);
    const header =
      (needsApproval ? "📨 Sent to the admins. " : "✅ On it! ") +
      (dmOk
        ? "I've sent this to your DMs too, where it keeps updating until it's done."
        : "Your DMs are closed, so I can't send you updates there. Check `/redownload status` anytime, and I'll mention you in the announcements channel when it's done.");
    await i.editReply({ ...trackerPayload(job), content: header });
    tracker.attachReply(job.id, i, header);
    await engine.updateLog(job);
    if (!needsApproval) void engine.tick(job.id);
  }

  // ---- the member's tracker card (Refresh / Cancel) ------------------------------------------
  async function onTracker(i: MessageComponentInteraction) {
    const [, action, arg] = i.customId.split(":");
    const job = rstore.job(Number(arg));
    if (!job || (job.discordUserId !== i.user.id && !access.isAdmin(i))) {
      return void (await i.reply({ content: "That isn't yours.", flags: MessageFlags.Ephemeral }));
    }
    if (action === "cancel") {
      if (!cancellable(job)) return void (await i.update(trackerPayload(job)));
      return void (await i.update({
        content: "Cancel this redownload? Nothing has been changed yet, and you'll get it back on your daily limit.",
        embeds: [trackerEmbed(job)],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`rdt:stop:${job.id}`).setLabel("Yes, cancel it").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`rdt:back:${job.id}`).setLabel("Keep going").setStyle(ButtonStyle.Secondary),
          ),
        ],
      }));
    }
    await i.deferUpdate();
    if (action === "stop") {
      const msg = await engine.cancel(job.id, i.user.id);
      const after = rstore.job(job.id)!;
      return void (await tracker.show(i, after, after.state === "cancelled" ? "" : msg));
    }
    if (action === "refresh" && Date.now() - job.updatedAt > 15_000) await engine.tick(job.id);
    await tracker.show(i, rstore.job(job.id)!);
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
        content: `🚫 <@${arg}> can no longer use redownloads${denied ? ` (and ${denied} waiting request${denied === 1 ? " was" : "s were"} denied)` : ""}. Anything already running keeps going; use its Cancel button to stop it. Undo with \`/admin redownloads unban\`.`,
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
    ];
    if (settings.requirePlex || link) {
      lines.push(`**Plex account:** ${link ? `${link.plexUsername} ${link.hasAccess ? "✅" : "❌ not on the share list"}` : "not linked. Run `/plex`"}`);
    }
    if (settings.paused) lines.push("⏸️ Redownloads are paused right now.");
    if (settings.banned[i.user.id]) lines.push("🚫 You can't start redownloads right now.");
    const e = new EmbedBuilder().setColor(Colors.info).setTitle("🔁 Your redownloads").setDescription(lines.join("\n"));
    const past = mine.filter((j) => !ACTIVE_STATES.includes(j.state)).slice(0, 6);
    if (past.length) e.addFields({ name: "Recent", value: truncate(past.map((j) => jobLine(j)).join("\n"), 1024) });
    if (!mine.length) e.addFields({ name: "How it works", value: "If something on Plex is broken (glitchy video, bad audio, wrong file), run `/redownload start` and I'll swap in a fresh copy." });
    // The live cards first (the same ones as in their DMs), then the summary.
    const cards = active.slice(0, 3).map((j) => trackerEmbed(j));
    const buttons = active.slice(0, 3).flatMap((j) => trackerPayload(j).components);
    await i.reply({ embeds: [...cards, e], components: buttons, flags: MessageFlags.Ephemeral });
  }

  async function titleAutocomplete(i: AutocompleteInteraction) {
    const typed = i.options.getFocused().trim();
    await i.respond(await library.search(typed));
  }

  // ---- admin ------------------------------------------------------------------------------
  const ADMIN_SUB = { ...ADMIN, group: { name: "redownloads", description: "Members' redownloads and /missing: pause, bans, approvals, history" } };
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
          s.paused
            ? `⏸️ **Paused** by <@${s.paused.by}> ${ts(s.paused.at)}${s.paused.reason ? `: ${s.paused.reason}` : ""}`
            : s.requirePlex
              ? "▶️ Open to members with a linked Plex account on the share list"
              : "▶️ Open to every member of this server",
          `Approve first: **${s.approvals ? "on" : "off"}** · Plex check: **${s.requirePlex ? "on" : "off"}**`,
          `Limits: ${lim.dailyLimit} per member per 24h (a season counts 2) · ${lim.titleCooldownHours}h cooldown per title · ${lim.maxActive} at once · ${lim.maxAttempts} releases tried`,
          `Log channel: ${logCh ? `<#${logCh}>` : "⚠️ none set, so redownloads are only in the container log (use `/setup channels redownload_log:`)"}`,
          `Plex linking: ${plexTv ? `${rstore.links().length} member(s) linked` : "off (needs PLEX_URL and PLEX_TOKEN)"}`,
        ].join("\n"),
      )
      .addFields({ name: "Apps", value: apps.join("\n") });
    if (active.length) e.addFields({ name: `Active (${active.length})`, value: truncate(active.map((j) => jobLine(j, true)).join("\n"), 1024) });
    const searches = new MissingStore(store).active();
    if (searches.length) {
      e.addFields({ name: `/missing searches running (${searches.length})`, value: truncate(searches.map((j) => `🔎 **#${j.id}** ${truncate(j.target.label, 60)} · <@${j.discordUserId}> · ${j.state.replace("_", " ")}`).join("\n"), 1024) });
    }
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
          .setDescription(truncate(jobs.map((j) => `${jobLine(j, true)}\n-# ${PROBLEMS[j.problem] ?? j.problem}${j.details ? `: ${truncate(j.details, 90)}` : ""}`).join("\n") || "None yet.", 4000)),
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
              o.setName("details").setDescription("Optional: anything else, e.g. 'picture freezes at 41:00'").setMaxLength(300),
            )
            .addIntegerOption((o) => o.setName("season").setDescription("Series: season number (required for series)").setMinValue(0).setMaxValue(200))
            .addIntegerOption((o) => o.setName("episode").setDescription("Series: episode number (leave empty to replace the whole season)").setMinValue(1).setMaxValue(2000)),
        execute: start,
        autocomplete: titleAutocomplete,
      },
      { ...PARENT, name: "status", description: "Your redownloads and how many you have left", execute: status },
      {
        ...ADMIN_SUB,
        name: "pause",
        description: "Stop members starting redownloads and /missing searches",
        build: (b) => b.addStringOption((o) => o.setName("reason").setDescription("Shown to members").setMaxLength(200)),
        execute: async (i) => {
          const reason = i.options.getString("reason") ?? undefined;
          update((s) => (s.paused = { by: i.user.id, reason, at: Date.now() }));
          log.info(`redownload: paused by ${i.user.id}${reason ? ` (${reason})` : ""}`);
          await i.reply({ content: "⏸️ Paused. Members can't start new redownloads; ones already running will finish. `/admin redownloads resume` to reopen.", flags: MessageFlags.Ephemeral });
        },
      },
      {
        ...ADMIN_SUB,
        name: "resume",
        description: "Let members use redownloads and /missing again",
        execute: async (i) => {
          update((s) => delete s.paused);
          log.info(`redownload: resumed by ${i.user.id}`);
          await i.reply({ content: "▶️ Redownloads are open again.", flags: MessageFlags.Ephemeral });
        },
      },
      {
        ...ADMIN_SUB,
        name: "ban",
        description: "Stop a member using redownloads and /missing",
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
        ...ADMIN_SUB,
        name: "unban",
        description: "Let a member use redownloads and /missing again",
        build: (b) => b.addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
        execute: async (i) => {
          const u = i.options.getUser("user", true);
          update((s) => delete s.banned[u.id]);
          log.info(`redownload: ${i.user.id} unbanned ${u.id}`);
          await i.reply({ content: `✅ <@${u.id}> can use redownloads again.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        },
      },
      {
        ...ADMIN_SUB,
        name: "approvals",
        description: "Require an admin to approve each redownload and /missing search",
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
        ...ADMIN_SUB,
        name: "plexcheck",
        description: "Only allow members with a linked Plex account (/plex)",
        build: (b) =>
          b.addStringOption((o) =>
            o
              .setName("mode")
              .setDescription("On: members must link Plex with /plex first. Off: any member of this server")
              .setRequired(true)
              .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" }),
          ),
        execute: async (i) => {
          const on = i.options.getString("mode", true) === "on";
          if (on && !plexTv) {
            await i.reply({ content: "Plex linking needs `PLEX_URL` and `PLEX_TOKEN` set first, so I left it off.", flags: MessageFlags.Ephemeral });
            return;
          }
          update((s) => (s.requirePlex = on));
          ctx.bus.emit("help-changed"); // /plex shows up in the guide only while it's needed
          log.info(`redownload: plex check ${on ? "on" : "off"} (${i.user.id})`);
          await i.reply({
            content: on
              ? `🔗 Plex check is **on**. Members need to run \`/plex\` with an account on your share list before they can redownload (${rstore.links().filter((l) => l.hasAccess).length} confirmed so far).`
              : "▶️ Plex check is **off**. Any member of this server can redownload (limits still apply).",
            flags: MessageFlags.Ephemeral,
          });
        },
      },
      {
        ...ADMIN_SUB,
        name: "history",
        description: "Recent redownloads",
        build: (b) => b.addUserOption((o) => o.setName("user").setDescription("Only this member")),
        execute: history,
      },
      { ...ADMIN_SUB, name: "overview", description: "Settings, safety checks and what's running", execute: overview },
    ],
    components: { rdc: onCard, rdl: onLog, rdt: onTracker },
    start: () => {
      engine.start();
      const pending = rstore.activeJobs().length;
      if (pending) log.info(`redownload: resuming ${pending} job(s) from before the restart`);
    },
    stop: () => engine.stop(),
  };
  return mod;
};

