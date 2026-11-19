/**
 * Merges what every module contributes into guild slash commands and routes
 * interactions back to the owning module. Admin gating and crash-proofing
 * happen here, once, for every handler.
 */
import {
  REST,
  Routes,
  SlashCommandBuilder,
  type Client,
  type Interaction,
  type MessageComponentInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { Config } from "../config.js";
import type { Access, Gate } from "./access.js";
import { discordErrorCode, respond, respondError } from "./discord.js";
import { log } from "./logger.js";
import type { BotModule, CommandDef, SubcommandDef } from "./module.js";
import { registrationHint } from "./setup.js";

type Handler = Pick<CommandDef, "adminOnly" | "gate" | "execute" | "autocomplete" | "description">;

export interface HelpLine {
  usage: string;
  description: string;
  gate?: Gate;
}

const gateOf = (h: Pick<CommandDef, "adminOnly" | "gate">): Gate | undefined => h.gate ?? (h.adminOnly ? "admin" : undefined);

export interface RegistrationStatus {
  ok: boolean;
  count?: number;
  guild?: string;
  error?: string;
  hint?: string;
  at?: string;
}

export class Registry {
  status: RegistrationStatus = { ok: false, error: "not registered yet (waiting for Discord login)" };
  private handlers = new Map<string, Handler>();
  private components = new Map<string, (i: MessageComponentInteraction) => Promise<void>>();
  private json: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
  readonly help: HelpLine[] = [];

  constructor(
    private readonly modules: BotModule[],
    private readonly cfg: Config,
    private readonly access: Access,
  ) {
    this.build();
  }

  private build() {
    const parents = new Map<string, { description: string; subs: SubcommandDef[] }>();
    for (const m of this.modules) {
      for (const c of m.commands ?? []) {
        if (this.handlers.has(c.name)) throw new Error(`Duplicate command /${c.name} (module ${m.name})`);
        const b = new SlashCommandBuilder().setName(c.name).setDescription(c.description);
        c.build?.(b);
        this.json.push(b.toJSON());
        this.handlers.set(c.name, c);
        this.help.push({ usage: `/${c.name}`, description: c.description, gate: gateOf(c) });
      }
      for (const s of m.subcommands ?? []) {
        const p = parents.get(s.parent) ?? { description: s.parentDescription, subs: [] };
        p.subs.push(s);
        parents.set(s.parent, p);
      }
      for (const [prefix, fn] of Object.entries(m.components ?? {})) {
        if (this.components.has(prefix)) throw new Error(`Duplicate component prefix "${prefix}" (module ${m.name})`);
        this.components.set(prefix, fn);
      }
    }
    for (const [name, { description, subs }] of parents) {
      if (this.handlers.has(name)) throw new Error(`/${name} is both a command and a subcommand parent`);
      const b = new SlashCommandBuilder().setName(name).setDescription(description);
      for (const s of subs) {
        b.addSubcommand((sb) => {
          sb.setName(s.name).setDescription(s.description);
          s.build?.(sb);
          return sb;
        });
        this.handlers.set(`${name} ${s.name}`, s);
        this.help.push({ usage: `/${name} ${s.name}`, description: s.description, gate: gateOf(s) });
      }
      this.json.push(b.toJSON());
    }
  }

  /**
   * Guild-scoped registration: instant, and PUT replaces the whole set, so
   * commands of disabled modules disappear automatically.
   */
  async register(client: Client<true>): Promise<void> {
    const rest = new REST().setToken(this.cfg.discordToken);
    const guildName = client.guilds.cache.get(this.cfg.guildId)?.name ?? this.cfg.guildId;
    try {
      const res = (await rest.put(Routes.applicationGuildCommands(client.application.id, this.cfg.guildId), { body: this.json })) as unknown[];
      this.status = { ok: true, count: res.length, guild: guildName, at: new Date().toISOString() };
      log.info(`discord: registered ${res.length} command(s) in "${guildName}": ${this.json.map((c) => `/${c.name}`).join(" ")}`);
    } catch (err) {
      const code = discordErrorCode(err);
      const hint = registrationHint(code, client.application.id);
      this.status = { ok: false, guild: guildName, error: (err as Error).message, hint, at: new Date().toISOString() };
      log.error(`discord: slash-command registration FAILED in "${guildName}": ${(err as Error).message}`);
      log.error(`discord: ${hint}`);
    }
  }

  async handle(i: Interaction): Promise<void> {
    if (i.guildId && i.guildId !== this.cfg.guildId) return;
    try {
      if (i.isChatInputCommand()) {
        const sub = i.options.getSubcommand(false);
        const h = this.handlers.get(sub ? `${i.commandName} ${sub}` : i.commandName);
        if (!h) return respond(i, "That command isn't available right now (its service may not be configured).");
        const denied = this.access.check(i, gateOf(h));
        if (denied) return respond(i, denied);
        await h.execute(i);
      } else if (i.isAutocomplete()) {
        const sub = i.options.getSubcommand(false);
        const h = this.handlers.get(sub ? `${i.commandName} ${sub}` : i.commandName);
        if (!h?.autocomplete) return void (await i.respond([]).catch(() => undefined));
        if (this.access.check(i, gateOf(h))) return void (await i.respond([]).catch(() => undefined));
        await h.autocomplete(i);
      } else if (i.isMessageComponent()) {
        const prefix = i.customId.split(":")[0];
        const fn = this.components.get(prefix);
        if (!fn) return respond(i, "This button has expired. Run the command again.");
        await fn(i);
      }
    } catch (err) {
      if (i.isAutocomplete()) {
        log.warn(`autocomplete failed: ${(err as Error).message}`);
        await i.respond([]).catch(() => undefined);
      } else if (i.isRepliable()) {
        await respondError(i, err);
      }
    }
  }
}
