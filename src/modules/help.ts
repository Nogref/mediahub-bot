/**
 * /help: a short, friendly guide grouped by what people want to do, showing
 * only what this member can use. Admin and inviter sections appear only for
 * them. Any command not listed here still shows up under "More", so nothing
 * new is ever hidden by accident.
 *
 * /setup help channel:#commands posts the same guide (the everyone view) as a
 * message that stays, like the welcome post, and updates itself whenever the
 * bot's commands change.
 */
import { ChannelType, EmbedBuilder, MessageFlags } from "discord.js";
import { Colors, respond } from "../core/discord.js";
import { LiveMessage } from "../core/liveMessage.js";
import { log } from "../core/logger.js";
import type { ModuleFactory } from "../core/module.js";
import type { HelpLine } from "../core/registry.js";
import { loadSettings } from "../redownload/policy.js";
import { SETUP } from "./parents.js";

interface Entry {
  /** Commands this line is about; shown only if at least one exists. */
  cmds: string[];
  text: string;
  /** Replaces the auto-formatted command list (e.g. "/setup …"). */
  display?: string;
  /** Also covers every command starting with these (so they don't land in "More"). */
  covers?: string[];
  /** Known, but not worth showing right now. */
  hidden?: boolean;
}

interface Section {
  title: string;
  gate?: "admin" | "inviter";
  entries: Entry[];
}

/** "/request movie", "/request series" → "`/request movie` · `series`". */
function formatCmds(cmds: string[]): string {
  let parent = "";
  return cmds
    .map((c) => {
      const parts = c.split(" ");
      const head = parts.slice(0, -1).join(" ");
      if (parts.length > 1 && head === parent) return `\`${parts.at(-1)}\``;
      parent = parts.length > 1 ? head : "";
      return `\`${c}\``;
    })
    .join(" · ");
}

export function helpModule(getLines: () => HelpLine[]): ModuleFactory {
  return ({ access, store, client, cfg, bus }) => {
    const board = new LiveMessage(client, store, "help");
    const sections = (): Section[] => [
      {
        title: "🎬 Get something new",
        entries: [
          { cmds: ["/request movie", "/request series", "/request album"], text: "Ask for it, and I'll DM you as it downloads" },
          { cmds: ["/requests"], text: "How your requests are going, and what's arrived" },
          { cmds: ["/random movie"], text: "Can't decide? Get a pick from the library" },
        ],
      },
      {
        title: "🛠️ Problems & ideas",
        entries: [
          { cmds: ["/redownload start", "/redownload status"], text: "Swap a broken file for a fresh copy yourself, and check on it" },
          { cmds: ["/missing"], text: "Get episodes missing from a show, or a movie that never downloaded" },
          { cmds: ["/report"], text: "Tell the admins about a problem" },
          { cmds: ["/suggest"], text: "Share an idea for the server. Others can 👍 it" },
        ],
      },
      {
        title: "🎵 Music",
        entries: [
          { cmds: ["/aurral"], text: "Your own music account, to listen on your phone or computer" },
        ],
      },
      {
        title: "ℹ️ Good to know",
        entries: [
          { cmds: ["/status"], text: "Is everything working right now?" },
          { cmds: ["/stats"], text: "How big the library is, and other fun numbers" },
          { cmds: ["/plezy"], text: "The better Plex app, and how to get it" },
          { cmds: ["/pings"], text: "Choose what the bot @-pings you about" },
          // Only worth mentioning when redownloads need it.
          { cmds: ["/plex"], text: "Link your Plex account (needed for redownloads)", hidden: !loadSettings(store).requirePlex },
        ],
      },
      {
        title: "🎟️ Inviting people",
        gate: "inviter",
        entries: [
          { cmds: ["/invite create", "/invite list", "/invite revoke"], text: "Make a Plex invite link (and DM it to someone), see open ones, cancel one" },
          { cmds: ["/invite aurral"], text: "Make someone a music account" },
        ],
      },
      {
        title: "🔒 Admin",
        gate: "admin",
        entries: [
          { cmds: ["/setup show"], display: "`/setup …`", covers: ["/setup "], text: "Channels, posts, boards and links. Start with `/setup show`" },
          { cmds: ["/admin redownloads overview"], display: "`/admin redownloads …`", covers: ["/admin redownloads "], text: "Limits, pause, bans, approvals, history. Start with `overview`" },
          { cmds: ["/admin plex linked"], display: "`/admin plex …`", covers: ["/admin plex "], text: "Who's linked their Plex account" },
          { cmds: ["/admin suggestions top"], display: "`/admin suggestions …`", covers: ["/admin suggestions "], text: "Most-liked ideas, and review-before-posting" },
          { cmds: ["/admin aurral link"], display: "`/admin aurral link`", text: "Connect an existing music account to a member" },
        ],
      },
    ];

    /** The guide for someone who can use `usable`; `canSee` decides the inviter/admin sections. */
    function render(usable: HelpLine[], canSee: (gate: "admin" | "inviter") => boolean): EmbedBuilder {
      const have = new Set(usable.map((l) => l.usage));
      const covered = new Set<string>(["/help"]);
      const coverPrefixes: string[] = [];
      const embed = new EmbedBuilder().setColor(Colors.info).setTitle("🤖 What I can do");
      for (const sec of sections()) {
        if (sec.gate && !canSee(sec.gate)) continue;
        const lines: string[] = [];
        for (const e of sec.entries) {
          const present = e.cmds.filter((c) => have.has(c));
          e.cmds.forEach((c) => covered.add(c));
          if (e.covers) coverPrefixes.push(...e.covers);
          if (!present.length || e.hidden) continue;
          lines.push(`${e.display ?? formatCmds(present)}\n-# ${e.text}`);
        }
        if (lines.length) embed.addFields({ name: sec.title, value: lines.join("\n") });
      }
      // Anything not in the guide above still gets listed.
      const extra = usable.filter((l) => !covered.has(l.usage) && !coverPrefixes.some((p) => l.usage.startsWith(p)));
      if (extra.length) {
        embed.addFields({ name: "➕ More", value: extra.map((l) => `\`${l.usage}\`\n-# ${l.description.replace(/^(Admin|Inviters): /, "")}`).join("\n").slice(0, 1024) });
      }
      return embed;
    }

    /** The posted guide: what every member can use, nothing gated. */
    function boardPayload() {
      const embed = render(
        getLines().filter((l) => !l.gate),
        () => false,
      )
        .setTitle("📖 Commands")
        .setDescription("Type **/** in this channel and pick one. Most replies are only visible to you, so ask away.")
        .setFooter({ text: "This updates by itself whenever new commands are added. /help shows it anytime." });
      return { embeds: [embed] };
    }

    async function refreshBoard() {
      await board.update(boardPayload()).catch((err) => log.warn(`help: couldn't refresh the commands guide: ${(err as Error).message}`));
    }
    bus.on("help-changed", () => void refreshBoard());

    return {
      name: "help",
      commands: [
        {
          name: "help",
          description: "What this bot can do for you",
          execute: async (i) => {
            const usable = getLines().filter((l) => !access.check(i, l.gate));
            const embed = render(usable, (gate) => !access.check(i, gate)).setFooter({
              text: access.isAdmin(i)
                ? "Only admins see /setup and /admin in the menu (Server Settings → Integrations changes who can)."
                : "Replies are only visible to you, unless a command says otherwise.",
            });
            await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          },
        },
      ],
      subcommands: [
        {
          ...SETUP,
          name: "help",
          description: "Post the commands guide in a channel (it stays and updates itself)",
          build: (b) =>
            b
              .addChannelOption((o) => o.setName("channel").setDescription("Where to post it (e.g. #commands)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
              .addBooleanOption((o) => o.setName("remove").setDescription("Take the guide down instead")),
          execute: async (i) => {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
            if (i.options.getBoolean("remove")) {
              const had = await board.remove();
              return void (await respond(i, had ? "🗑️ Commands guide taken down." : "There's no commands guide posted."));
            }
            const channel = i.options.getChannel("channel");
            if (!channel) {
              const link = board.link(cfg.guildId);
              return void (await respond(i, link ? `📖 The commands guide is here: ${link}. Pick a channel to move it.` : "Pick a channel to post the commands guide in."));
            }
            const msg = await board.place(channel.id, boardPayload());
            await respond(i, `📖 Commands guide posted in <#${msg.channelId}>. It updates itself when commands change.\nTip: pin it, and use \`/setup commands-only\` on that channel so it stays tidy.`);
          },
        },
      ],
      // A new version may have new commands: bring the posted guide up to date.
      start: () => {
        if (board.location) void refreshBoard();
      },
    };
  };
}
