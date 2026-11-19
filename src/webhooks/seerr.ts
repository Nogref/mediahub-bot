/**
 * Seerr → Settings → Notifications → Webhook (default JSON payload works as-is).
 * MEDIA_AVAILABLE is the authoritative "it's on Plex now" signal for movies and shows.
 */
import { keys, str, toInt, type InboundEvent } from "../notify/events.js";
import { posterUrl } from "../services/seerr.js";

type Body = {
  notification_type?: string;
  event?: string;
  subject?: string;
  message?: string;
  image?: string;
  media?: { media_type?: string; tmdbId?: string | number; tvdbId?: string | number } | null;
  request?: { request_id?: string | number; requestedBy_username?: string } | null;
  issue?: { issue_id?: string | number; issue_type?: string; issue_status?: string; reportedBy_username?: string } | null;
  comment?: { comment_message?: string; commentedBy_username?: string } | null;
};

export function parseSeerr(body: Body): InboundEvent[] {
  const type = body.notification_type ?? "";
  switch (type) {
    case "TEST_NOTIFICATION":
      return [{ type: "alert", source: "Seerr", level: "info", title: "Seerr webhook connected", message: "Test notification received.", dedupeKey: `test:seerr:${Date.now()}` }];
    case "MEDIA_FAILED":
      return [
        {
          type: "alert",
          source: "Seerr",
          level: "warn",
          title: `Request failed: ${body.subject ?? "unknown title"}`,
          message: "Seerr couldn't hand this request to Radarr/Sonarr. Check Seerr's logs and service settings.",
          dedupeKey: `seerr:failed:${body.request?.request_id ?? body.subject}`,
        },
      ];
    case "MEDIA_AVAILABLE": {
      const mediaType = body.media?.media_type === "tv" ? "tv" : "movie";
      const tmdbId = toInt(body.media?.tmdbId);
      const tvdbId = toInt(body.media?.tvdbId);
      const subject = str(body.subject) ?? "Unknown title";
      // Seerr subjects look like "Title (2024)".
      const m = subject.match(/^(.*?)\s*\((\d{4})\)\s*$/);
      const title = m ? m[1] : subject;
      const year = m ? Number(m[2]) : undefined;
      const image = str(body.image);
      const match = { kind: mediaType, tmdbId, tvdbId, seerrRequestId: toInt(body.request?.request_id) } as const;
      return [
        {
          type: "media",
          source: "Seerr",
          kind: mediaType === "tv" ? "series" : "movie",
          title,
          year,
          overview: str(body.message),
          imageUrl: image?.startsWith("/") ? posterUrl(image) : image,
          match,
          confirms: true,
          dedupeKey: mediaType === "tv" ? keys.series({ tmdbId, tvdbId }, title) : keys.movie(tmdbId, title, year),
        },
      ];
    }
    case "ISSUE_CREATED":
      return [
        {
          type: "alert",
          source: "Seerr",
          level: "warn",
          title: `New ${str(body.issue?.issue_type)?.toLowerCase() ?? ""} issue: ${body.subject ?? "unknown title"}`.replace("  ", " "),
          message: [str(body.message), body.issue?.reportedBy_username ? `Reported by ${body.issue.reportedBy_username}` : ""].filter(Boolean).join("\n") || undefined,
          dedupeKey: `seerr:issue:${body.issue?.issue_id ?? body.subject}`,
        },
      ];
    case "ISSUE_RESOLVED":
    case "ISSUE_REOPENED": {
      const issueId = toInt(body.issue?.issue_id);
      if (!issueId) return [];
      return [
        {
          type: "issue",
          source: "Seerr",
          action: type === "ISSUE_RESOLVED" ? "resolved" : "reopened",
          issueId,
          title: str(body.subject),
          dedupeKey: `seerr:issue:${type}:${issueId}`,
        },
      ];
    }
    default:
      // Pending/approved/auto-approved/declined and issue comments: Seerr's own business.
      return [];
  }
}
