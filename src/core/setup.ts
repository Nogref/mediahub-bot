/**
 * Startup self-diagnosis for the most common setup mistakes: a wrong GUILD_ID,
 * or a bot invited without the applications.commands scope.
 */

/** bot + applications.commands with View Channels, Send Messages, Embed Links, Attach Files,
 *  Read Message History, Manage Roles, Connect and Speak. */
export const INVITE_PERMISSIONS = "271707136"; // …plus Manage Messages (commands-only channels)

export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

export interface GuildRef {
  id: string;
  name: string;
}

export type GuildResolution =
  | { kind: "ok"; guild: GuildRef }
  | { kind: "fallback"; guild: GuildRef; configured: string }
  | { kind: "none" }
  | { kind: "ambiguous"; configured: string; guilds: GuildRef[] };

/**
 * GUILD_ID matches a server the bot is in → use it. If it doesn't, but the bot
 * is in exactly one server, that's clearly the one meant (this is a single-server bot).
 */
export function resolveGuild(configured: string, guilds: GuildRef[]): GuildResolution {
  const hit = guilds.find((g) => g.id === configured);
  if (hit) return { kind: "ok", guild: hit };
  if (guilds.length === 1) return { kind: "fallback", guild: guilds[0], configured };
  if (guilds.length === 0) return { kind: "none" };
  return { kind: "ambiguous", configured, guilds };
}

/** Plain-English explanation for a failed command registration. */
export function registrationHint(code: number | undefined, applicationId: string): string {
  switch (code) {
    case 50001:
      return `Discord says "Missing Access": the bot was added without the applications.commands scope, or it isn't in that server. Re-invite it with: ${inviteUrl(applicationId)}`;
    case 10004:
      return "Discord says \"Unknown Guild\": GUILD_ID isn't a valid server ID. Right-click your server icon → Copy Server ID (Developer Mode must be on).";
    case 50035:
      return "Discord rejected the command definitions (invalid form body). Please report this with the full log.";
    case 30032:
      return "Too many commands in this server for this bot (limit 100).";
    default:
      return "Check the error above; the README's Troubleshooting section lists common fixes.";
  }
}
