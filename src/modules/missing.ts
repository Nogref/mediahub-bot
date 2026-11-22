/**
 * /missing: members fill in what's missing themselves.
 *   /missing title:<show> [season]  → which episodes have aired but aren't on Plex → download them
 *   /missing title:<movie>          → a movie in the library that never downloaded → look for it now
 *   /missing                        → your searches in progress
 *
 * One season (or movie) per request, no daily limit: nothing is ever deleted.
 * Uses the same switches as redownloads (pause, bans, approve-first, Plex
 * check) and the same log channel. Whatever can't be found is reported to the
 * member and posted in the log for an admin.
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
import { Colors, truncate } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { BotModule, ModuleFactory } from "../core/module.js";
import { TtlCache } from "../core/ttlCache.js";
import { MissingEngine } from "../missing/engine.js";
import { trackerEmbed, trackerPayload } from "../missing/render.js";
import { MISSING_ACTIVE, MissingStore, type MissingItem, type MissingTarget } from "../missing/store.js";
import { buildAdapters, type ArrApi } from "../redownload/arr.js";
import { confirmedPlex } from "../redownload/gate.js";
import { loadSettings } from "../redownload/policy.js";
import { RedownloadStore } from "../redownload/store.js";
import { plexTvFor } from "../services/plextv.js";

type Json = Record<string, any>;

const RETRY_COOLDOWN_MS = 6 * 3_600_000;
const MAX_ACTIVE = 10;
const pad = (n: number) => String(n).padStart(2, "0");
const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const poster = (images: Json[] | undefined) => {
  const u = (images ?? []).find((i) => i.coverType === "poster")?.remoteUrl;
  return typeof u === "string" && /^https?:\/\//.test(u) ? u : undefined;
};
const aired = (e: Json) => !!e.airDateUtc && Date.parse(e.airDateUtc) <= Date.now();

interface Session {
  userId: string;
  admin: boolean;
  plexUsername?: string;
  target: MissingTarget;
  /** Everything missing in that season (or the movie). */
  available: MissingItem[];
  chosen: number[];
}

export const missing: ModuleFactory = (ctx) => {
  const { cfg, store, client, access } = ctx;
  const adapters = buildAdapters(cfg);
  const api: { sonarr?: ArrApi; radarr?: ArrApi } = { sonarr: adapters.sonarr?.api, radarr: adapters.radarr?.api };
  if (!api.sonarr && !api.radarr) return null;

  const mstore = new MissingStore(store);
  const rstore = new RedownloadStore(store);
  const plexTv = plexTvFor(ctx);
  const engine = new MissingEngine({ api, mstore, client, cfg });
  const sessions = new TtlCache<string, Session>(10 * 60_000);
  const library = new TtlCache<string, Array<{ value: string; name: string; hay: string }>>(5 * 60_000);

  // ---- finding titles -------------------------------------------------------------------------
  async function titles() {
    const hit = library.get("all");
    if (hit) return hit;
    const out: Array<{ value: string; name: string; hay: string }> = [];
    if (api.sonarr) {
      for (const s of await api.sonarr.call<Json[]>(`/series`).catch(() => [] as Json[])) {
        const st = s.statistics ?? {};
        const gaps = (st.episodeCount ?? 0) > (st.episodeFileCount ?? 0);
        out.push({ value: `s:${s.id}`, name: `📺 ${s.title}${s.year ? ` (${s.year})` : ""}${gaps ? " · some missing" : ""}`, hay: fold(`${s.title} ${s.year ?? ""}`) });
      }
    }
    if (api.radarr) {
      for (const m of await api.radarr.call<Json[]>(`/movie`).catch(() => [] as Json[])) {
        if (m.hasFile || !m.isAvailable) continue;
        out.push({ value: `m:${m.id}`, name: `🎬 ${m.title}${m.year ? ` (${m.year})` : ""} · never downloaded`, hay: fold(`${m.title} ${m.year ?? ""}`) });
      }
    }
    library.set("all", out);
    return out;
  }

  async function search(typed: string, limit = 25) {
    const q = fold(typed);
    if (q.length < 2) return [];
    const words = q.split(" ");
    return (await titles())
      .filter((e) => words.every((w) => e.hay.includes(w)))
      .sort((a, b) => Number(!a.hay.startsWith(q)) - Number(!b.hay.startsWith(q)) || a.hay.length - b.hay.length)
      .slice(0, limit)
      .map((e) => ({ name: truncate(e.name, 100), value: e.value }));
  }

  // ---- gates ----------------------------------------------------------------------------------
  /** Pause, bans and the Plex check (shared with redownloads). Null when OK. */
  async function memberGate(userId: string, admin: boolean): Promise<{ block?: string; plexUsername?: string }> {
    const s = loadSettings(store);
    if (admin) return { plexUsername: rstore.link(userId)?.plexUsername };
    if (s.paused) return { block: `⏸️ This is paused by an admin${s.paused.reason ? `: ${s.paused.reason}` : ""}. Try again later.` };
    const ban = s.banned[userId];
    if (ban) return { block: `🚫 You can't use this right now${ban.reason ? ` (${ban.reason})` : ""}. Ask an admin if you think that's a mistake.` };
    if (s.requirePlex) {
      const p = await confirmedPlex(rstore, plexTv, userId);
      if (!p.ok) return { block: p.reason };
      return { plexUsername: p.username };
    }
    return { plexUsername: rstore.link(userId)?.plexUsername };
  }

  /** Locks and cooldowns, checked again right before the job is created (no awaits in between). */
  function jobGate(key: string, admin: boolean): string | null {
    const active = mstore.active();
    const same = active.find((j) => j.target.key === key);
    if (same) return `⏳ I'm already on it (#${same.id}). Check \`/missing\` to see how it's going.`;
    if (admin) return null;
    if (active.length >= MAX_ACTIVE) return "🚦 Lots of searches are running right now. Please try again in a little while.";
    const recent = mstore.lastUnsuccessful(key, Date.now() - RETRY_COOLDOWN_MS);
    if (recent) {
      const when = Math.floor((recent.finishedAt! + RETRY_COOLDOWN_MS) / 1000);
      return `🧊 I looked for these <t:${Math.floor(recent.finishedAt! / 1000)}:R> and couldn't get them, and the admins know. You can try again <t:${when}:R>.`;
    }
    return null;
  }

  // ---- /missing --------------------------------------------------------------------------------
  async function status(i: ChatInputCommandInteraction) {
    const mine = mstore.recent(8, i.user.id);
    const active = mine.filter((j) => MISSING_ACTIVE.includes(j.state));
    const past = mine.filter((j) => !MISSING_ACTIVE.includes(j.state)).slice(0, 5);
    const e = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle("🔎 Missing episodes and movies")
      .setDescription(
        "If a show on Plex is missing an episode, or a movie never showed up, run `/missing` with its title and I'll find it." +
          (past.length ? `\n\n**Recent**\n${past.map((j) => `• #${j.id} ${truncate(j.target.label, 60)} · ${j.state.replace("_", " ")}`).join("\n")}` : ""),
      );
    await i.reply({
      embeds: [...active.slice(0, 3).map((j) => trackerEmbed(j)), e],
      components: active.slice(0, 3).flatMap((j) => trackerPayload(j).components),
      flags: MessageFlags.Ephemeral,
    });
  }

  async function start(i: ChatInputCommandInteraction) {
    const pick = i.options.getString("title")?.trim();
    if (!pick) return status(i);
    const season = i.options.getInteger("season") ?? undefined;
    const admin = access.isAdmin(i);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const gate = await memberGate(i.user.id, admin);
    if (gate.block) return void (await i.editReply(gate.block));

    let value = pick;
    if (!/^[sm]:\d+$/.test(pick)) {
      const hits = await search(pick, 2);
      if (hits.length !== 1) {
        return void (await i.editReply(
          hits.length
            ? `More than one title matches **${truncate(pick, 60)}**. Pick one from the suggestions as you type.`
            : `I couldn't find **${truncate(pick, 60)}** in the library. If it's not on Plex at all, ask for it with \`/request\`.`,
        ));
      }
      value = hits[0].value;
    }
    const [kind, idStr] = value.split(":");
    const id = Number(idStr);
    if (kind === "m") return movieCard(i, id, admin, gate.plexUsername);
    return seriesCard(i, id, season, admin, gate.plexUsername);
  }

  async function movieCard(i: ChatInputCommandInteraction, id: number, admin: boolean, plexUsername?: string) {
    if (!api.radarr) return void (await i.editReply("Movies aren't set up for this yet (Radarr needs an API key)."));
    const m = await api.radarr.call<Json>(`/movie/${id}`);
    const label = `${m.title}${m.year ? ` (${m.year})` : ""}`;
    if (m.hasFile) return void (await i.editReply(`**${label}** is already on Plex. If it's broken, \`/redownload start\` swaps in a fresh copy.`));
    if (!m.isAvailable) {
      const when = [m.digitalRelease, m.physicalRelease].map((d) => (d ? Date.parse(d) : NaN)).filter((n) => n > Date.now()).sort()[0];
      return void (await i.editReply(`**${label}** isn't out to watch at home yet${when ? ` (expected <t:${Math.floor(when / 1000)}:D>)` : ""}. It'll download automatically once it is.`));
    }
    const target: MissingTarget = { kind: "movie", app: "radarr", key: `missing:radarr:${id}`, label, posterUrl: poster(m.images), movieId: id };
    const blocked = jobGate(target.key, admin);
    if (blocked) return void (await i.editReply(blocked));
    const sid = randomBytes(6).toString("hex");
    const s: Session = { userId: i.user.id, admin, plexUsername, target, available: [{ id, label, state: "searching" }], chosen: [id] };
    sessions.set(sid, s);
    await i.editReply(card(sid, s));
  }

  async function seriesCard(i: ChatInputCommandInteraction | MessageComponentInteraction, id: number, season: number | undefined, admin: boolean, plexUsername?: string) {
    if (!api.sonarr) return void (await i.editReply("TV shows aren't set up for this yet (Sonarr needs an API key)."));
    const [series, eps] = await Promise.all([api.sonarr.call<Json>(`/series/${id}`), api.sonarr.call<Json[]>(`/episode`, { query: { seriesId: id } })]);
    const missingAired = eps.filter((e) => aired(e) && !e.hasFile);
    if (season === undefined) {
      const seasons = [...new Set(missingAired.filter((e) => e.seasonNumber > 0).map((e) => e.seasonNumber as number))].sort((a, b) => a - b);
      if (!seasons.length) {
        const next = eps.filter((e) => !aired(e) && e.airDateUtc && e.seasonNumber > 0).sort((a, b) => Date.parse(a.airDateUtc) - Date.parse(b.airDateUtc))[0];
        return void (await i.editReply(
          `👍 Nothing's missing from **${series.title}**: every episode that's aired is on Plex.` +
            (next ? `\nNext up: S${pad(next.seasonNumber)}E${pad(next.episodeNumber)} airs <t:${Math.floor(Date.parse(next.airDateUtc) / 1000)}:R>.` : ""),
        ));
      }
      if (seasons.length > 1) {
        const sid = randomBytes(6).toString("hex");
        sessions.set(sid, { userId: i.user.id, admin, plexUsername, target: { kind: "episodes", app: "sonarr", key: "", label: series.title, seriesId: id }, available: [], chosen: [] });
        return void (await i.editReply({
          content: `**${series.title}** is missing episodes in ${seasons.length} seasons. Which one?`,
          embeds: [],
          components: [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`msc:season:${sid}`)
                .setPlaceholder("Pick a season")
                .addOptions(
                  seasons.slice(0, 25).map((n) => {
                    const count = missingAired.filter((e) => e.seasonNumber === n).length;
                    return { label: `Season ${n}`, description: `${count} missing`, value: String(n) };
                  }),
                ),
            ),
          ],
        }));
      }
      season = seasons[0];
    }

    const inSeason = eps.filter((e) => e.seasonNumber === season);
    const gaps = inSeason.filter((e) => aired(e) && !e.hasFile).sort((a, b) => a.episodeNumber - b.episodeNumber);
    const sLabel = season === 0 ? "Specials" : `Season ${season}`;
    if (!inSeason.length) return void (await i.editReply(`**${series.title}** has no ${sLabel}.`));
    if (!gaps.length) return void (await i.editReply(`👍 Nothing's missing from **${series.title}** ${sLabel}: every episode that's aired is on Plex.`));
    const target: MissingTarget = {
      kind: "episodes",
      app: "sonarr",
      key: `missing:sonarr:${id}:${season}`,
      label: `${series.title} · ${sLabel}`,
      posterUrl: poster(series.images),
      seriesId: id,
      seasonNumber: season,
      wholeSeason: inSeason.filter(aired).every((e) => !e.hasFile),
    };
    const blocked = jobGate(target.key, admin);
    if (blocked) return void (await i.editReply(blocked));
    const available: MissingItem[] = gaps.map((e) => ({
      id: e.id,
      label: `E${pad(e.episodeNumber)}${e.title && e.title !== "TBA" ? ` · ${truncate(e.title, 50)}` : ""}`,
      state: "searching",
    }));
    const upcoming = inSeason.filter((e) => !aired(e)).length;
    const sid = randomBytes(6).toString("hex");
    const s: Session = { userId: i.user.id, admin, plexUsername, target, available, chosen: available.map((a) => a.id) };
    sessions.set(sid, s);
    await i.editReply(card(sid, s, upcoming));
  }

  function card(sid: string, s: Session, upcoming = 0) {
    const approvals = loadSettings(store).approvals && !s.admin;
    const movie = s.target.kind === "movie";
    const chosen = s.available.filter((a) => s.chosen.includes(a.id));
    const e = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle(truncate(`${movie ? "🎬" : "📺"} ${s.target.label}`, 256))
      .setDescription(
        movie
          ? "This movie is in the library but never downloaded. Want me to look for it now?"
          : `**${s.available.length} episode${s.available.length === 1 ? " has" : "s have"} aired but ${s.available.length === 1 ? "isn't" : "aren't"} on Plex:**\n` +
              truncate(s.available.map((a) => `${s.chosen.includes(a.id) ? "☑️" : "⬜"} ${a.label}`).join("\n"), 3000) +
              (upcoming ? `\n\n-# ${upcoming} more ${upcoming === 1 ? "hasn't" : "haven't"} aired yet. Those arrive by themselves.` : ""),
      )
      .setFooter({ text: approvals ? "An admin will need to OK it first. I'll keep you posted in your DMs." : "I'll keep you posted in your DMs while they download." });
    if (s.target.posterUrl) e.setThumbnail(s.target.posterUrl);
    const go = movie ? "Look for it" : chosen.length === s.available.length ? `Get ${chosen.length === 1 ? "it" : `all ${chosen.length}`}` : `Get these ${chosen.length}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`msc:go:${sid}`).setLabel(approvals ? `Ask an admin (${movie ? "movie" : chosen.length})` : go).setEmoji("⬇️").setStyle(ButtonStyle.Success),
    );
    if (!movie && s.available.length > 1) row.addComponents(new ButtonBuilder().setCustomId(`msc:pick:${sid}`).setLabel("Choose episodes").setStyle(ButtonStyle.Secondary));
    row.addComponents(new ButtonBuilder().setCustomId(`msc:x:${sid}`).setLabel("Never mind").setStyle(ButtonStyle.Secondary));
    return { content: "", embeds: [e], components: [row] };
  }

  // ---- buttons --------------------------------------------------------------------------------
  async function onCard(i: MessageComponentInteraction) {
    const [, action, sid] = i.customId.split(":");
    const s = sessions.get(sid);
    if (!s) return void (await i.update({ content: "⌛ That expired. Run `/missing` again.", embeds: [], components: [] }));
    if (s.userId !== i.user.id) return void (await i.reply({ content: "That isn't yours.", flags: MessageFlags.Ephemeral }));

    if (action === "x") {
      sessions.delete(sid);
      return void (await i.update({ content: "👍 Okay.", embeds: [], components: [] }));
    }
    if (action === "season" && i.isStringSelectMenu()) {
      await i.deferUpdate();
      sessions.delete(sid);
      return seriesCard(i, s.target.seriesId!, Number(i.values[0]), s.admin, s.plexUsername);
    }
    if (action === "pick") {
      return void (await i.update({
        content: "Pick the episodes you want.",
        embeds: [],
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`msc:sel:${sid}`)
              .setPlaceholder("Choose episodes")
              .setMinValues(1)
              .setMaxValues(Math.min(25, s.available.length))
              .addOptions(s.available.slice(0, 25).map((a) => ({ label: truncate(a.label, 100), value: String(a.id), default: s.chosen.includes(a.id) }))),
          ),
        ],
      }));
    }
    if (action === "sel" && i.isStringSelectMenu()) {
      const ids = new Set(i.values.map(Number));
      s.chosen = s.available.filter((a) => ids.has(a.id)).map((a) => a.id);
      return void (await i.update(card(sid, s)));
    }
    if (action !== "go") return;

    // Checked again with no awaits before the job exists, so double clicks can't double-book.
    const blocked = jobGate(s.target.key, s.admin);
    sessions.delete(sid);
    if (blocked) return void (await i.update({ content: blocked, embeds: [], components: [] }));
    const approvals = loadSettings(store).approvals && !s.admin;
    const items = s.available.filter((a) => s.chosen.includes(a.id)).map((a) => ({ ...a, state: "searching" as const }));
    const job = mstore.create({
      discordUserId: s.userId,
      plexUsername: s.plexUsername,
      target: { ...s.target, wholeSeason: s.target.wholeSeason && items.length === s.available.length },
      items,
      state: approvals ? "awaiting_approval" : "searching",
      events: [{ at: Date.now(), text: `🙋 Requested by <@${s.userId}>` }],
      bypassLimits: s.admin,
    });
    log.info(`missing #${job.id}: ${s.userId} → ${job.target.label} (${items.length} item${items.length === 1 ? "" : "s"})`);
    await i.deferUpdate();
    const dmOk = await engine.startTracker(job);
    const header =
      (approvals ? "📨 Sent to the admins. " : "✅ On it! ") +
      (dmOk ? "I've sent this to your DMs too, where it keeps updating." : "Your DMs are closed, so check `/missing` anytime to see how it's going.");
    await i.editReply({ ...trackerPayload(job), content: header });
    engine.attachReply(job.id, i, header);
    await engine.updateLog(job);
    if (!approvals) void engine.tick(job.id);
  }

  async function onTracker(i: MessageComponentInteraction) {
    const [, action, idStr] = i.customId.split(":");
    const job = mstore.job(Number(idStr));
    if (!job || (job.discordUserId !== i.user.id && !access.isAdmin(i))) return void (await i.reply({ content: "That isn't yours.", flags: MessageFlags.Ephemeral }));
    if (action === "cancel") {
      return void (await i.update({
        content: "Stop looking for these? Anything that's already on Plex stays.",
        embeds: [trackerEmbed(job)],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`mst:stop:${job.id}`).setLabel("Yes, stop").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`mst:back:${job.id}`).setLabel("Keep going").setStyle(ButtonStyle.Secondary),
          ),
        ],
      }));
    }
    await i.deferUpdate();
    if (action === "stop") await engine.cancel(job.id, i.user.id);
    else if (action === "refresh" && Date.now() - job.updatedAt > 15_000) await engine.tick(job.id);
    const fresh = mstore.job(job.id)!;
    await i.editReply(trackerPayload(fresh));
  }

  async function onLog(i: MessageComponentInteraction) {
    const [, action, idStr] = i.customId.split(":");
    if (!access.isAdmin(i)) return void (await i.reply({ content: "🔒 Only admins can use these buttons.", flags: MessageFlags.Ephemeral }));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const id = Number(idStr);
    const msg = action === "approve" ? await engine.approve(id, i.user.id) : action === "deny" ? await engine.deny(id, i.user.id) : action === "cancel" ? await engine.cancel(id, i.user.id) : "Unknown action.";
    await i.editReply(msg);
  }

  async function autocomplete(i: AutocompleteInteraction) {
    await i.respond(await search(i.options.getFocused().trim()));
  }

  const mod: BotModule & { engine: MissingEngine; mstore: MissingStore } = {
    engine, // exposed for tests
    mstore,
    name: "missing",
    commands: [
      {
        name: "missing",
        description: "Get episodes missing from a show, or a movie that never downloaded",
        build: (b) =>
          b
            .addStringOption((o) => o.setName("title").setDescription("The show or movie (start typing). Leave empty to see your searches").setAutocomplete(true))
            .addIntegerOption((o) => o.setName("season").setDescription("Shows: which season (optional, I'll ask if there's more than one)").setMinValue(0).setMaxValue(200)),
        execute: start,
        autocomplete,
      },
    ],
    components: { msc: onCard, mst: onTracker, msl: onLog },
    start: () => {
      engine.start();
      const n = mstore.active().length;
      if (n) log.info(`missing: resuming ${n} search(es) from before the restart`);
    },
    stop: () => engine.stop(),
  };
  return mod;
};
