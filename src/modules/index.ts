/**
 * The feature list. Each entry is independent: remove a line (and its file)
 * to drop that feature. Factories return null when their service isn't
 * configured, so unconfigured features never register commands.
 */
import type { ModuleFactory } from "../core/module.js";
import { invites } from "./invites.js";
import { mediaRequests } from "./mediaRequests.js";
import { myRequests } from "./myRequests.js";
import { optin } from "./optin.js";
import { music } from "./music.js";
import { musicRequests } from "./musicRequests.js";
import { random } from "./random.js";
import { report } from "./report.js";
import { requestTracker } from "./requestTracker.js";
import { stats } from "./stats.js";
import { statusBoard } from "./statusBoard.js";
import { webhooks } from "./webhooks.js";

export const moduleFactories: ModuleFactory[] = [
  mediaRequests, // /request movie|series        → Seerr
  musicRequests, // /request album               → Lidarr / Aurral
  music, //         /music play|radio|queue|…    → Subsonic into a voice channel
  myRequests, //    /requests                    → your requests + live progress
  report, //        /report                      → Seerr issues, DM when fixed
  webhooks, //      POST /webhook/:service       → batched notifications + @mentions
  requestTracker, // polls pending bot requests  → @mentions if a webhook was missed
  statusBoard, //   live board, /statusboard, /status
  invites, //       /invite create|list|revoke   → Wizarr
  random, //        /random movie                → Plex
  stats, //         /stats                       → Plex, Lidarr, Seerr
  optin, //         /optin me|setup + button panel → opt-in roles
  // /help is added in src/index.ts because it lists everything above.
];
