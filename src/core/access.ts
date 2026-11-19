/**
 * Command gates, checked once in the registry before any handler runs.
 *  - admin:   ADMIN_ROLE_ID (or Discord Administrator if unset)
 *  - inviter: admins, plus INVITER_ROLE_ID
 * Everything else (requests, music, Aurral) is open to every member.
 */
import type { BaseInteraction } from "discord.js";
import type { Config } from "../config.js";
import { isAdmin } from "./discord.js";

export type Gate = "admin" | "inviter";

export const GATE_ICON: Record<Gate, string> = { admin: "🔒", inviter: "🎟️" };

export function hasRole(i: BaseInteraction, roleId: string | undefined): boolean {
  if (!roleId || !i.member) return false;
  const roles = i.member.roles;
  return Array.isArray(roles) ? roles.includes(roleId) : roles.cache.has(roleId);
}

export class Access {
  constructor(private readonly cfg: Config) {}

  isAdmin(i: BaseInteraction): boolean {
    return isAdmin(i, this.cfg.adminRoleId);
  }

  isInviter(i: BaseInteraction): boolean {
    return this.isAdmin(i) || hasRole(i, this.cfg.invites.inviterRoleId);
  }

  /** null when allowed, otherwise the message to show. */
  check(i: BaseInteraction, gate: Gate | undefined): string | null {
    switch (gate) {
      case undefined:
        return null;
      case "admin":
        return this.isAdmin(i) ? null : "🔒 That command is for server admins only.";
      case "inviter":
        return this.isInviter(i) ? null : "🎟️ Only admins and members with the Inviter role can do that.";
    }
  }
}
