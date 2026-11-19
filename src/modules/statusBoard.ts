/**
 * Live status board (one message, edited in place), up/down heads-ups,
 * /statusboard post|repost and the on-demand /status.
 */
import { EmbedBuilder, MessageFlags, type Message, type SendableChannels } from "discord.js";
import { Colors, DiscordCodes, discordErrorCode, respond, ts } from "../core/discord.js";
import { ApiError } from "../core/http.js";
import { log } from "../core/logger.js";
import type { AppContext, ModuleFactory, SubcommandDef } from "../core/module.js";
import { healthTargets } from "../services/index.js";

export interface CheckResult {
  key: string;
  name: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export type ViewState = "up" | "slow" | "flaky" | "down";

export interface ServiceView {
  key: string;
  name: string;
  state: ViewState;
  latencyMs: number;
  error?: string;
  since?: number;
}

export interface Transition {
  name: string;
  up: boolean;
  error?: string;
  downForMs?: number;
}

const BOARD_KEY = "statusboard";

function shortError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.kind === "timeout") return "timeout";
    if (err.kind === "network") return err.message.replace(/^could not reach \w+\s*/, "").replace(/[()]/g, "") || "unreachable";
    if (err.status) return `HTTP ${err.status}`;
  }
  return (err as Error)?.message?.slice(0, 60) ?? "error";
}

export async function runChecks(ctx: AppContext): Promise<CheckResult[]> {
  return Promise.all(
    healthTargets(ctx.services).map(async ({ key, client }) => {
      const t0 = performance.now();
      try {
        await client.health();
        return { key, name: client.name, ok: true, latencyMs: Math.round(performance.now() - t0) };
      } catch (err) {
        return { key, name: client.name, ok: false, latencyMs: Math.round(performance.now() - t0), error: shortError(err) };
      }
    }),
  );
}

/**
 * Debounced up/down tracking: a service is "down" only after N consecutive
 * failures (STATUS_FAIL_THRESHOLD), "flaky" before that. Confirmed states are
 * persisted so a restart neither misses nor repeats a transition.
 */
export class HealthTracker {
  private failures = new Map<string, number>();

  constructor(
    private readonly threshold: number,
    private readonly slowMs: number,
    private readonly confirmed: Map<string, { up: boolean; changedAt: number }>,
    private readonly persist: (key: string, up: boolean, at: number) => void,
  ) {}

  evaluate(results: CheckResult[], now = Date.now()): { views: ServiceView[]; transitions: Transition[] } {
    const views: ServiceView[] = [];
    const transitions: Transition[] = [];
    for (const r of results) {
      const prev = this.confirmed.get(r.key);
      if (r.ok) {
        this.failures.set(r.key, 0);
        if (!prev || !prev.up) {
          if (prev && !prev.up) transitions.push({ name: r.name, up: true, downForMs: now - prev.changedAt });
          this.confirmed.set(r.key, { up: true, changedAt: now });
          this.persist(r.key, true, now);
        }
        views.push({ key: r.key, name: r.name, state: r.latencyMs > this.slowMs ? "slow" : "up", latencyMs: r.latencyMs });
      } else {
        const n = (this.failures.get(r.key) ?? 0) + 1;
        this.failures.set(r.key, n);
        if (n >= this.threshold) {
          if (!prev || prev.up) {
            if (prev?.up) transitions.push({ name: r.name, up: false, error: r.error });
            this.confirmed.set(r.key, { up: false, changedAt: now });
            this.persist(r.key, false, now);
          }
          views.push({ key: r.key, name: r.name, state: "down", latencyMs: r.latencyMs, error: r.error, since: this.confirmed.get(r.key)!.changedAt });
        } else {
          views.push({ key: r.key, name: r.name, state: "flaky", latencyMs: r.latencyMs, error: r.error });
        }
      }
    }
    return { views, transitions };
  }
}

/** Stateless view for /status: a single failed check counts as down. */
export function instantViews(results: CheckResult[], slowMs: number): ServiceView[] {
  return results.map((r) => ({
    key: r.key,
    name: r.name,
    state: r.ok ? (r.latencyMs > slowMs ? "slow" : "up") : "down",
    latencyMs: r.latencyMs,
    error: r.error,
  }));
}

export function overall(views: ServiceView[]): { color: number; summary: string } {
  const down = views.filter((v) => v.state === "down").length;
  const degraded = views.filter((v) => v.state === "slow" || v.state === "flaky").length;
  if (down) return { color: Colors.bad, summary: `🔴 ${down} of ${views.length} service${views.length === 1 ? "" : "s"} down` };
  if (degraded) return { color: Colors.warn, summary: `🟡 Degraded: ${degraded} service${degraded === 1 ? " is" : "s are"} slow or not answering` };
  return { color: Colors.ok, summary: "🟢 All systems operational" };
}

export function line(v: ServiceView): string {
  const ms = `${v.latencyMs.toLocaleString("en-US")} ms`;
  switch (v.state) {
    case "up":
      return `✅ **${v.name}** · ${ms}`;
    case "slow":
      return `✅ **${v.name}** · ${ms} · slow`;
    case "flaky":
      return `⚠️ **${v.name}** · not answering (${v.error ?? "error"}), re-checking`;
    case "down":
      return `❌ **${v.name}** · down${v.since ? ` since ${ts(v.since)}` : ""} (${v.error ?? "error"})`;
  }
}

export function renderBoard(views: ServiceView[], opts: { live: boolean; intervalSeconds?: number }): EmbedBuilder {
  const { color, summary } = overall(views);
  const embed = new EmbedBuilder()
    .setColor(views.length ? color : Colors.muted)
    .setTitle("📡 Media stack status")
    .setDescription(views.length ? `${summary}\n\n${views.map(line).join("\n")}` : "Checking services…")
    .setTimestamp(new Date());
  if (opts.live) embed.setFooter({ text: `Checked every ${opts.intervalSeconds}s · last updated` });
  return embed;
}

export const statusBoard: ModuleFactory = (ctx) => {
  const { cfg, store, client } = ctx;
  if (!healthTargets(ctx.services).length) return null;

  // Read at use time: /setup channels can change it while the bot runs.
  const statusChannelId = () => cfg.channels.status;
  const tracker = new HealthTracker(cfg.status.failThreshold, cfg.status.slowMs, store.serviceStates(), (k, up, at) => store.setServiceState(k, up, at));
  let board: Message | undefined;
  let views: ServiceView[] = [];
  let lastSig = "";
  let lastEditAt = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const link = (m: { channelId: string; id: string }) => `https://discord.com/channels/${cfg.guildId}/${m.channelId}/${m.id}`;

  async function statusChannel(): Promise<SendableChannels | undefined> {
    const channelId = statusChannelId();
    if (!channelId) return undefined;
    const ch = await client.channels.fetch(channelId).catch((err) => {
      log.error(`status: can't open the status channel ${channelId}: ${(err as Error).message}`);
      return null;
    });
    if (!ch?.isSendable()) {
      log.error(`status: status channel ${channelId} isn't a text channel the bot can post in`);
      return undefined;
    }
    return ch;
  }

  async function postBoard(): Promise<Message | undefined> {
    const ch = await statusChannel();
    if (!ch) return undefined;
    const msg = await ch.send({ embeds: [renderBoard(views, { live: true, intervalSeconds: cfg.status.intervalSeconds })] });
    store.kvSet(BOARD_KEY, { channelId: msg.channelId, messageId: msg.id });
    lastEditAt = Date.now();
    lastSig = signature(views);
    log.info(`status: posted a new status board (${msg.id})`);
    return msg;
  }

  /** Finds the stored board message, or posts a new one if it's gone or in another channel. */
  async function ensureBoard(): Promise<Message | undefined> {
    if (board && board.channelId !== statusChannelId()) {
      // Status channel changed via /setup channels: retire the old board.
      await board.delete().catch(() => undefined);
      board = undefined;
    }
    if (board) return board;
    const stored = store.kvGet<{ channelId: string; messageId: string }>(BOARD_KEY);
    if (stored && stored.channelId === statusChannelId()) {
      const ch = await statusChannel();
      if (!ch) return undefined;
      try {
        board = await ch.messages.fetch(stored.messageId);
        return board;
      } catch (err) {
        const code = discordErrorCode(err);
        if (code !== DiscordCodes.UnknownMessage) throw err;
        log.warn("status: stored status board message was deleted; posting a new one");
      }
    }
    board = await postBoard();
    return board;
  }

  const signature = (vs: ServiceView[]) => vs.map((v) => `${v.key}:${v.state}`).join("|");

  async function headsUp(t: Transition) {
    const ch = await statusChannel();
    if (!ch) return;
    const mins = t.downForMs ? Math.max(1, Math.round(t.downForMs / 60_000)) : undefined;
    const text = t.up
      ? `🟢 **${t.name}** is back up${mins ? ` (was down for ${mins >= 60 ? `${(mins / 60).toFixed(1)} h` : `${mins} min`})` : ""}.`
      : `🔴 **${t.name}** is down (${t.error ?? "error"}).`;
    const role = ctx.roles.get("status");
    await ch
      .send({ content: role ? `<@&${role}> ${text}` : text, allowedMentions: { parse: [], roles: role ? [role] : [] } })
      .catch((err) => log.warn(`status: heads-up failed: ${(err as Error).message}`));
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const results = await runChecks(ctx);
      const evaluated = tracker.evaluate(results);
      views = evaluated.views;
      for (const t of evaluated.transitions) {
        log.info(`status: ${t.name} is ${t.up ? "UP" : "DOWN"}`);
        await headsUp(t);
      }
      if (!statusChannelId()) return;

      const sig = signature(views);
      const due = sig !== lastSig || Date.now() - lastEditAt >= cfg.status.refreshMinutes * 60_000;
      if (!due) return; // nothing but latency/timestamp changed: save the API call

      const msg = await ensureBoard();
      if (!msg) return;
      if (lastSig === sig && Date.now() - lastEditAt < 5000) return; // just posted with these exact contents
      try {
        await msg.edit({ embeds: [renderBoard(views, { live: true, intervalSeconds: cfg.status.intervalSeconds })] });
      } catch (err) {
        if (discordErrorCode(err) !== DiscordCodes.UnknownMessage) throw err;
        board = undefined;
        await ensureBoard();
      }
      lastSig = sig;
      lastEditAt = Date.now();
    } catch (err) {
      log.error(`status: tick failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  const subcommands: SubcommandDef[] = [
        {
          parent: "statusboard",
          parentDescription: "Manage the live status board",
          name: "post",
          description: "Post the live status board (or link to it if it already exists)",
          execute: async (i) => {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
            const existing = board ?? (await ensureBoardIfStored());
            if (existing) return void (await respond(i, `📡 The status board is already live: ${link(existing)}`));
            const msg = await postBoard();
            board = msg;
            await respond(i, msg ? `📡 Posted the status board: ${link(msg)}` : statusChannelId() ? "⚠️ I couldn't post in the status channel. Check my permissions there." : "Set a status channel first: `/setup channels status:#channel`.");
          },
        },
        {
          parent: "statusboard",
          parentDescription: "Manage the live status board",
          name: "repost",
          adminOnly: true,
          description: "Admin: abandon the current board and post a fresh one",
          execute: async (i) => {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
            const old = board;
            const msg = await postBoard();
            if (!msg) return void (await respond(i, statusChannelId() ? "⚠️ I couldn't post in the status channel. Check my permissions there." : "Set a status channel first: `/setup channels status:#channel`."));
            board = msg;
            if (old) {
              await old
                .edit({ embeds: [new EmbedBuilder().setColor(Colors.muted).setTitle("📡 Status board moved").setDescription(`It now lives here: ${link(msg)}`)] })
                .catch(() => undefined);
            }
            await respond(i, `📡 Fresh status board posted: ${link(msg)}`);
          },
        },
      ];

  /** Like ensureBoard, but never posts: used by /statusboard post to decide. */
  async function ensureBoardIfStored(): Promise<Message | undefined> {
    const stored = store.kvGet<{ channelId: string; messageId: string }>(BOARD_KEY);
    if (!stored || stored.channelId !== statusChannelId()) return undefined;
    const ch = await statusChannel();
    if (!ch) return undefined;
    try {
      board = await ch.messages.fetch(stored.messageId);
      return board;
    } catch {
      return undefined;
    }
  }

  return {
    name: "status-board",
    commands: [
      {
        name: "status",
        description: "Check every service right now (only you see the answer)",
        execute: async (i) => {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const results = await runChecks(ctx);
          await i.editReply({ embeds: [renderBoard(instantViews(results, cfg.status.slowMs), { live: false })] });
        },
      },
    ],
    subcommands,
    start: async () => {
      if (!statusChannelId()) log.info("status: no status channel yet (set one with /setup channels status:#channel); /status still works");
      // First tick finds the stored board (or posts a new one) and fills it in.
      await tick();
      timer = setInterval(() => void tick(), cfg.status.intervalSeconds * 1000);
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
};
