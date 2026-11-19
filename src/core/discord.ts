/** Discord helpers shared by modules: admin checks, safe replies, colors, formatting. */
import {
  DiscordAPIError,
  MessageFlags,
  PermissionFlagsBits,
  type BaseInteraction,
  type Client,
  type MessageCreateOptions,
  type InteractionReplyOptions,
  type RepliableInteraction,
} from "discord.js";
import { friendlyError } from "./http.js";
import { log } from "./logger.js";

export const Colors = {
  ok: 0x2ecc71,
  warn: 0xf1c40f,
  bad: 0xe74c3c,
  info: 0x5865f2,
  muted: 0x95a5a6,
  plex: 0xe5a00d,
} as const;

export function isAdmin(i: BaseInteraction, adminRoleId?: string): boolean {
  const member = i.member;
  if (!member) return false;
  if (adminRoleId) {
    const roles = member.roles;
    // Cached GuildMember has a manager; the raw API member has a string[].
    if (Array.isArray(roles)) return roles.includes(adminRoleId);
    return roles.cache.has(adminRoleId);
  }
  // No role configured: fall back to Discord's own Administrator permission.
  return i.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

/** Replies, edits or follows up depending on interaction state, always ephemerally. */
export async function respond(i: RepliableInteraction, content: InteractionReplyOptions | string): Promise<void> {
  const opts: InteractionReplyOptions = typeof content === "string" ? { content } : content;
  try {
    if (i.deferred || i.replied) {
      const { flags: _flags, ...rest } = opts;
      await i.editReply(rest);
    } else {
      await i.reply({ ...opts, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    log.warn(`discord: could not respond to interaction: ${(err as Error).message}`);
  }
}

export async function respondError(i: RepliableInteraction, err: unknown): Promise<void> {
  if (!(err instanceof Error) || err.name !== "ApiError") log.error("handler error", err);
  else log.warn(`handler: ${(err as Error).message}`);
  await respond(i, { content: friendlyError(err), embeds: [], components: [], files: [] });
}

export function discordErrorCode(err: unknown): number | undefined {
  if (err instanceof DiscordAPIError) return typeof err.code === "number" ? err.code : undefined;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

export const DiscordCodes = {
  UnknownChannel: 10003,
  UnknownMessage: 10008,
  MissingAccess: 50001,
  CannotDM: 50007,
  MissingPermissions: 50013,
} as const;

/** Sends a DM; returns false (never throws) when the member has DMs closed or can't be reached. */
export async function dm(client: Client, userId: string, payload: MessageCreateOptions | string): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch (err) {
    log.info(`discord: couldn't DM ${userId}: ${(err as Error).message}`);
    return false;
  }
}

export function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Discord dynamic timestamp, e.g. <t:1700000000:R> renders as "3 minutes ago". */
export function ts(ms: number, style: "R" | "f" | "F" | "d" | "t" = "R"): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function yearOf(date: string | undefined | null): number | undefined {
  if (!date) return undefined;
  const y = Number(String(date).slice(0, 4));
  return Number.isInteger(y) && y > 1800 ? y : undefined;
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}
