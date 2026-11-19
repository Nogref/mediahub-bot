/** /help → every command this member can use. */
import { EmbedBuilder, MessageFlags } from "discord.js";
import { GATE_ICON } from "../core/access.js";
import { Colors } from "../core/discord.js";
import type { ModuleFactory } from "../core/module.js";
import type { HelpLine } from "../core/registry.js";

/** Help needs the finished command list, which exists only after every module is built. */
export function helpModule(getLines: () => HelpLine[]): ModuleFactory {
  return ({ access }) => ({
    name: "help",
    commands: [
      {
        name: "help",
        description: "List the bot's commands",
        execute: async (i) => {
          const lines = getLines()
            .filter((l) => !access.check(i, l.gate))
            .sort((a, b) => a.usage.localeCompare(b.usage))
            .map((l) => `${l.gate ? `${GATE_ICON[l.gate]} ` : ""}\`${l.usage}\` — ${l.description.replace(/^Admin: /, "")}`);
          const legend = [access.isAdmin(i) ? "🔒 admins only" : "", access.isInviter(i) ? "🎟️ inviters" : ""].filter(Boolean).join(" · ");
          const embed = new EmbedBuilder()
            .setColor(Colors.info)
            .setTitle("🤖 Commands")
            .setDescription(lines.join("\n"))
            .setFooter({ text: legend || "Search results and replies are only visible to you." });
          await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        },
      },
    ],
  });
}
