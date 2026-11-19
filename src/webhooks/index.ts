/**
 * Webhook parsers by URL segment: POST /webhook/<service>.
 * Add a service by writing a parser that returns InboundEvent[] and listing it here.
 */
import type { InboundEvent } from "../notify/events.js";
import { parseLidarr, parseRadarr, parseSonarr } from "./arr.js";
import { parseAurral } from "./aurral.js";
import { parseSeerr } from "./seerr.js";
import { parseTautulli } from "./tautulli.js";

export type WebhookParser = (body: any) => InboundEvent[];

export const webhookParsers: Record<string, WebhookParser> = {
  seerr: parseSeerr,
  tautulli: parseTautulli,
  radarr: parseRadarr,
  sonarr: parseSonarr,
  lidarr: parseLidarr,
  aurral: parseAurral,
};
