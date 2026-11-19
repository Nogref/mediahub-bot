/** Express server for inbound webhooks plus a /healthz endpoint for Docker. */
import express, { Router } from "express";
import type { Server } from "node:http";
import type { Client } from "discord.js";
import { log } from "../core/logger.js";
import type { BotModule } from "../core/module.js";

export function startServer(port: number, modules: BotModule[], client: Client): Server {
  const app = express();
  app.disable("x-powered-by");
  // Read everything as text and parse it ourselves: some senders forget Content-Type.
  app.use(express.text({ type: () => true, limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true, discord: client.isReady() ? "connected" : "connecting" });
  });

  const router = Router();
  for (const m of modules) m.routes?.(router);
  app.use(router);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const server = app.listen(port, () => log.info(`http: listening on :${port} (webhooks at /webhook/<service>)`));
  server.on("error", (err) => log.error(`http: server error: ${err.message}`));
  return server;
}
