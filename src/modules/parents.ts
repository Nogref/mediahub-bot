/**
 * Shared command parents, so features can add subcommands to the same place.
 *
 *  /setup …  one-time setup: channels, posts, boards, links (admins)
 *  /admin …  day-to-day controls: redownloads, Plex links, Aurral (admins)
 *  /invite … inviting people: Plex invites, music accounts (inviters)
 *
 * Commands that are entirely admin-only are hidden from members' slash menu.
 */
export const SETUP = { parent: "setup", parentDescription: "Admin: set up the bot's posts, boards, channels and links", gate: "admin" } as const;
export const ADMIN = { parent: "admin", parentDescription: "Admin: redownloads, Plex links and music accounts", gate: "admin" } as const;
export const INVITE = { parent: "invite", parentDescription: "Inviters: invite someone to Plex or make them a music account", gate: "inviter" } as const;
