/**
 * Entry point: config → store → service clients → Discord client → modules →
 * command registry → webhook server. The bot is a thin shell; if it dies,
 * Seerr/Radarr/Sonarr/Lidarr/Aurral/Wizarr keep working without it.
 */
import { Client, Events, GatewayIntentBits } from "discord.js";
import { EventEmitter } from "node:events";
import { loadConfig } from "./config.js";
import { Access } from "./core/access.js";
import { Store } from "./core/db.js";
import { setDefaultTimeout } from "./core/http.js";
import { log } from "./core/logger.js";
import type { AppContext, BotModule } from "./core/module.js";
import { Registry } from "./core/registry.js";
import { RoleDirectory } from "./core/roles.js";
import { applyStoredSettings } from "./core/settings.js";
import { inviteUrl, resolveGuild } from "./core/setup.js";
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
  // No privileged intents. Guild messages are only so commands-only channels can
  // remove non-command messages (the bot never reads their text). Voice states
  // are only requested when music streaming is configured.
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, ...(cfg.subsonic ? [GatewayIntentBits.GuildVoiceStates] : [])];
  const client = new Client({ intents });
  applyStoredSettings(cfg, store); // channels/links set from Discord win over env
  const roles = new RoleDirectory(store, cfg);
  const access = new Access(cfg);
  const notifier = new Notifier(client, store, cfg, roles);
  const ctx: AppContext = { cfg, store, client, services, notifier, roles, access, bus: new EventEmitter() };

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
    log.info(`discord: invite / re-authorize link: ${inviteUrl(c.application.id)}`);
    const guilds = [...c.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
    const found = resolveGuild(cfg.guildId, guilds);
    switch (found.kind) {
      case "ok":
        log.info(`discord: serving "${found.guild.name}" (${found.guild.id})`);
        break;
      case "fallback":
        log.warn(
          `discord: GUILD_ID ${found.configured} isn't a server this bot is in. It's only in "${found.guild.name}", so using that. ` +
            `Set GUILD_ID=${found.guild.id} to silence this warning.`,
        );
        cfg.guildId = found.guild.id;
        break;
      case "none":
        log.error(`discord: the bot isn't in any server yet. Add it with the invite link above, then restart the container.`);
        break;
      case "ambiguous":
        log.error(
          `discord: GUILD_ID ${found.configured} isn't one of this bot's servers: ${found.guilds.map((g) => `"${g.name}" (${g.id})`).join(", ")}. Set GUILD_ID to the right one and restart.`,
        );
        break;
    }
    if (found.kind === "ok" || found.kind === "fallback") await registry!.register(c);
    else registry!.status = { ok: false, error: "GUILD_ID doesn't match a server the bot is in", hint: "See the container log for the servers it's in." };
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

  const server = startServer(cfg.http.port, modules, client, () => ({ commands: registry?.status }));

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
