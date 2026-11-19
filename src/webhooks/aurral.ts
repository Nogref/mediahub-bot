/**
 * Aurral → Settings → Notifications → Webhooks, with the JSON body from the README.
 * "Request available" means the album is downloaded and playable in Aurral.
 */
import { keys, str, type InboundEvent } from "../notify/events.js";

type Body = Record<string, unknown>;

export function parseAurral(b: Body): InboundEvent[] {
  const event = str(b.event) ?? "";
  switch (event) {
    case "webhookTest":
      return [{ type: "alert", source: "Aurral", level: "info", title: "Aurral webhook connected", dedupeKey: `test:aurral:${Date.now()}` }];
    case "notifyRequestAvailable": {
      const title = str(b.album) ?? "Unknown album";
      const artist = str(b.artist);
      return [
        {
          type: "media",
          source: "Aurral",
          kind: "album",
          title,
          subtitle: artist,
          match: { kind: "album", title, artistName: artist },
          confirms: true,
          dedupeKey: keys.album(artist, title),
        },
      ];
    }
    default:
      // Request made, artist added, per-track, flow and discovery events are left to Aurral.
      return [];
  }
}
