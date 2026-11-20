/**
 * The feature list. Each entry is independent: remove a line (and its file)
 * to drop that feature. Factories return null when their service isn't
 * configured, so unconfigured features never register commands.
 */
import type { ModuleFactory } from "../core/module.js";
import { aurralAccounts } from "./aurralAccounts.js";
import { invites } from "./invites.js";
import { mediaRequests } from "./mediaRequests.js";
import { music } from "./music.js";
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
import { stats } from "./stats.js";
import { statusBoard } from "./statusBoard.js";
import { webhooks } from "./webhooks.js";

export const moduleFactories: ModuleFactory[] = [
  mediaRequests, // /request movie|series        → Seerr
  musicRequests, // /request album               → Lidarr / Aurral
  music, //         /music … + /setup nowplaying → Subsonic into a voice channel
  aurralAccounts, // /aurral signup|create|link|account
  myRequests, //    /requests                    → your requests + live progress
  report, //        /report                      → Seerr issues, DM when fixed
  plexLink, //      /plex link|status|unlink      → confirms members are on the Plex server
  redownload, //    /redownload …                 → members replace broken files themselves
  webhooks, //      POST /webhook/:service       → batched announcements + @mentions
  requestTracker, // polls pending bot requests  → @mentions if a webhook was missed
  statusBoard, //   live board, /statusboard, /status
  stats, //         /stats + /setup stats board
  invites, //       /invite create|list|revoke   → Wizarr
  random, //        /random movie                → Plex
  posts, //         /setup welcome|plezy|edit|reset, /plezy
  pings, //         /pings, /setup pings, ping-settings buttons
  settings, //      /setup channels|links|show
  // /help is added in src/index.ts because it lists everything above.
];
