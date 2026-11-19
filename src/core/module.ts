/**
 * The module contract. Every feature is a factory in src/modules/ that returns
 * a BotModule (or null when its env vars are missing). The registry merges
 * what modules contribute; deleting a module file and its line in
 * src/modules/index.ts removes the feature cleanly.
 */
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import type { Client } from "discord.js";
import type { Config } from "../config.js";
import type { Store } from "./db.js";
import type { Services } from "../services/index.js";
import type { Notifier } from "../notify/notifier.js";
import type { Router } from "express";
import type { EventEmitter } from "node:events";
import type { Access, Gate } from "./access.js";
import type { RoleDirectory } from "./roles.js";

export interface AppContext {
  cfg: Config;
  store: Store;
  client: Client;
  services: Services;
  notifier: Notifier;
  roles: RoleDirectory;
  access: Access;
  /** In-process events between modules, e.g. "settings-changed" after /setup links. */
  bus: EventEmitter;
}

interface CommandBase {
  description: string;
  /** Shorthand for gate: "admin". */
  adminOnly?: boolean;
  /** Who may run it: admin, inviter (admins + INVITER_ROLE_ID) or music (Music opt-in). */
  gate?: Gate;
  execute(i: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(i: AutocompleteInteraction): Promise<void>;
}

/** A top-level command with no subcommands, e.g. /stats. */
export interface CommandDef extends CommandBase {
  name: string;
  build?(b: SlashCommandBuilder): void;
}

/**
 * A subcommand, e.g. /request movie. Several modules may contribute to the same
 * parent (/request movie|series comes from Seerr, /request album from music).
 */
export interface SubcommandDef extends CommandBase {
  parent: string;
  parentDescription: string;
  name: string;
  build?(b: SlashCommandSubcommandBuilder): void;
}

export interface BotModule {
  name: string;
  commands?: CommandDef[];
  subcommands?: SubcommandDef[];
  /** Component handlers keyed by custom_id prefix (the text before the first ':'). */
  components?: Record<string, (i: MessageComponentInteraction) => Promise<void>>;
  /** Modal (pop-up form) submit handlers keyed by custom_id prefix. */
  modals?: Record<string, (i: ModalSubmitInteraction) => Promise<void>>;
  /** Express routes mounted on the webhook server. */
  routes?(router: Router): void;
  /** Called once the Discord client is ready. */
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export type ModuleFactory = (ctx: AppContext) => BotModule | null;
