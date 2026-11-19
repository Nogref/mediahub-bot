/**
 * Entry point: config → store → service clients → Discord client → modules →
 * command registry → webhook server. The bot is a thin shell; if it dies,
 * Seerr/Radarr/Sonarr/Lidarr/Aurral/Wizarr keep working without it.
 */
import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadConfig } from "./config.js";
import { Access } from "./core/access.js";
import { Store } from "./core/db.js";
import { setDefaultTimeout } from "./core/http.js";
import { log } from "./core/logger.js";
import type { AppContext, BotModule } from "./core/module.js";
import { Registry } from "./core/registry.js";
import { RoleDirectory } from "./core/roles.js";
import { helpModule } from "./modules/help.js";
import { moduleFactories } from "./modules/index.js";
import { Notifier } from "./notify/notifier.js";
import { buildServices } from "./services/index.js";
import { startServer } from "./web/server.js";

async function main() {
  const cfg = loadConfig();
  setDefaultTimeout(cfg.http.timeoutMs);

  const store = new Store(cfg.dataDir);
  const services = buildServices(cfg);
  // Slash commands only: no Message Content or privileged member intents. Voice
  // states are only requested when music streaming is configured.
  const intents = [GatewayIntentBits.Guilds, ...(cfg.subsonic ? [GatewayIntentBits.GuildVoiceStates] : [])];
  const client = new Client({ intents });
  const roles = new RoleDirectory(store, cfg);
  const access = new Access(cfg, roles);
  const notifier = new Notifier(client, store, cfg, roles);
  const ctx: AppContext = { cfg, store, client, services, notifier, roles, access };

  let registry: Registry | undefined;
  const factories = [...moduleFactories, helpModule(() => registry?.help ?? [])];
  const modules: BotModule[] = [];
  for (const f of factories) {
    try {
      const m = f(ctx);
      if (m) modules.push(m);
    } catch (err) {
      log.error(`module failed to initialise; skipping it`, err);
    }
  }
  registry = new Registry(modules, cfg, access);

  const configured = Object.entries(services)
    .filter(([, v]) => v)
    .map(([k]) => k);
  log.info(`services configured: ${configured.join(", ") || "none"}`);
  log.info(`modules enabled: ${modules.map((m) => m.name).join(", ")}`);

  client.once(Events.ClientReady, async (c) => {
    log.info(`discord: logged in as ${c.user.tag}`);
    if (!c.guilds.cache.has(cfg.guildId)) {
      log.error(`discord: the bot isn't in guild ${cfg.guildId}. Invite it with the URL from the README, then restart.`);
    }
    try {
      await registry!.register(c);
    } catch (err) {
      log.error("discord: slash-command registration failed (check GUILD_ID and that the bot was invited with applications.commands)", err);
    }
    for (const m of modules) {
      try {
        await m.start?.();
      } catch (err) {
        log.error(`module ${m.name} failed to start`, err);
      }
    }
  });
  client.on(Events.InteractionCreate, (i) => void registry!.handle(i));
  client.on(Events.Error, (err) => log.error(`discord: client error: ${err.message}`));
  client.on(Events.Warn, (msg) => log.warn(`discord: ${msg}`));

  const server = startServer(cfg.http.port, modules, client);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    for (const m of modules) await Promise.resolve(m.stop?.()).catch(() => undefined);
    await notifier.flushAll().catch(() => undefined);
    notifier.stop();
    server.close();
    await client.destroy().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await client.login(cfg.discordToken);
}

// A bug in one handler must never take the bot down.
process.on("unhandledRejection", (reason) => log.error("unhandled promise rejection", reason));
process.on("uncaughtException", (err) => log.error("uncaught exception", err));

main().catch((err) => {
  log.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
