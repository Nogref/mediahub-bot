/**
 * The feature list. Each entry is independent: remove a line (and its file)
 * to drop that feature. Factories return null when their service isn't
 * configured, so unconfigured features never register commands.
 */
import type { ModuleFactory } from "../core/module.js";
import { aurralAccounts } from "./aurralAccounts.js";
import { invites } from "./invites.js";
import { mediaRequests } from "./mediaRequests.js";
import { musicRequests } from "./musicRequests.js";
import { myRequests } from "./myRequests.js";
import { pings } from "./pings.js";
import { plexLink } from "./plexLink.js";
import { posts } from "./posts.js";
import { random } from "./random.js";
import { redownload } from "./redownload.js";
import { report } from "./report.js";
import { requestTracker } from "./requestTracker.js";
import { settings } from "./settings.js";
import { commandsOnly } from "./commandsOnly.js";
import { missing } from "./missing.js";
import { stats } from "./stats.js";
import { suggestions } from "./suggestions.js";
import { statusBoard } from "./statusBoard.js";
import { webhooks } from "./webhooks.js";

export const moduleFactories: ModuleFactory[] = [
  mediaRequests, // /request movie|series        → Seerr
  musicRequests, // /request album               → Lidarr / Aurral
  myRequests, //    /requests                    → your requests + live progress
  report, //        /report                      → Seerr issues, DM when fixed
  suggestions, //   /suggest + /admin suggestions … → ideas posted for 👍 votes, family-friendly
  commandsOnly, //  /setup commands-only          → removes non-command messages in chosen channels
  // Order matters for menus: /admin lists redownloads, then plex, then aurral;
  // /invite lists create/list/revoke before aurral.
  redownload, //    /redownload … + /admin redownloads … → members replace broken files themselves
  missing, //       /missing                      → members fill in missing episodes / movies that never downloaded
  plexLink, //      /plex · /admin plex …         → confirms members are on the Plex server
  invites, //       /invite create|list|revoke   → Wizarr
  aurralAccounts, // /aurral · /invite aurral · /admin aurral link
  webhooks, //      POST /webhook/:service       → batched announcements + @mentions
  requestTracker, // live DM trackers for requests (also ones made on the Seerr website)
  statusBoard, //   live board, /setup statusboard, /status
  stats, //         /stats + /setup stats board
  random, //        /random movie                → Plex
  posts, //         /setup welcome|plezy|edit|reset, /plezy
  pings, //         /pings, /setup pings, ping-settings buttons
  settings, //      /setup channels|links|show
  // /help is added in src/index.ts because it lists everything above.
];
