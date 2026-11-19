/**
 * POST /webhook/:service: inbound notifications from Seerr, Tautulli, Radarr,
 * Sonarr, Lidarr and Aurral, handed to the batching notifier.
 */
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import { webhookParsers } from "../webhooks/index.js";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function presentedSecret(req: Request): string | undefined {
  const q = req.query.secret ?? req.query.token;
  if (typeof q === "string") return q;
  const h = req.get("x-webhook-secret");
  if (h) return h;
  const auth = req.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

export const webhooks: ModuleFactory = ({ cfg, notifier }) => {
  if (!cfg.channels.notify && !cfg.channels.admin && !cfg.channels.status) {
    return null; // nowhere to post anything
  }

  return {
    name: "webhooks",
    routes: (router) => {
      router.post("/webhook/:service", (req: Request, res: Response) => {
        const service = String(req.params.service).toLowerCase();
        const parse = webhookParsers[service];
        if (!parse) {
          res.status(404).json({ error: `unknown service "${service}". Known: ${Object.keys(webhookParsers).join(", ")}` });
          return;
        }
        if (cfg.http.webhookSecret) {
          const given = presentedSecret(req);
          if (!given || !safeEqual(given, cfg.http.webhookSecret)) {
            log.warn(`webhook: rejected ${service} call from ${req.ip} (bad or missing secret)`);
            res.status(401).json({ error: "bad or missing secret" });
            return;
          }
        }

        let body: unknown = req.body;
        if (typeof body === "string") {
          try {
            body = body.trim() ? JSON.parse(body) : {};
          } catch {
            res.status(400).json({ error: "body must be JSON" });
            return;
          }
        }
        if (!body || typeof body !== "object") {
          res.status(400).json({ error: "body must be a JSON object" });
          return;
        }

        try {
          const events = parse(body);
          log.debug(`webhook: ${service} → ${events.length} event(s)`);
          if (events.length) notifier.publish(events);
          res.status(200).json({ ok: true, accepted: events.length });
        } catch (err) {
          log.error(`webhook: ${service} payload could not be handled`, err);
          res.status(422).json({ error: "payload not understood" });
        }
      });
    },
  };
};
