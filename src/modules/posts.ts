/**
 * Editable info posts: the welcome post (start-here channel) and the Plezy guide.
 *  - /setup welcome channel:#x   post it (or move it); later edits update it in place
 *  - /setup plezy channel:#x     same for the Plezy guide (optional)
 *  - /setup edit post:…          opens a form pre-filled with the current text
 *  - /setup reset post:…         back to the built-in text
 *  - /plezy                      anyone: posts the Plezy guide publicly in the current channel
 *
 * Text is plain Discord markdown, split into a title and up to four sections.
 * Tokens: {server} (server name), {requests} (requests website), {music} or {aurral}
 * (music website), {relay} (Plezy relay). A line with {requests} or {music} is left
 * out while that link isn't set (/setup links).
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { Colors } from "../core/discord.js";
import { LiveMessage, type LivePayload } from "../core/liveMessage.js";
import { log } from "../core/logger.js";
import type { AppContext, ModuleFactory } from "../core/module.js";
import { SETUP } from "./settings.js";

export type PostName = "welcome" | "plezy";

export interface PostContent {
  title: string;
  sections: string[]; // up to 4
}

export const PLEZY_URL = "https://plezy.app";
const MAX_SECTIONS = 4;
const MESSAGE_EMBED_LIMIT = 6000; // Discord's limit for all embeds in one message
const PUBLIC_COOLDOWN_MS = 60_000;

export const DEFAULT_POSTS: Record<PostName, PostContent> = {
  welcome: {
    title: "👋 Welcome to {server}",
    sections: [
      "This is our private media server: movies, TV and music for a small group of friends, running on our own hardware. This Discord is how you use it.\n\n" +
        "**New here?** Ask an admin (or anyone with the Inviter role) for a Plex invite. The bot DMs you a link that walks you through joining.\n\n" +
        "🎬 **Request on the web:** {requests} (sign in with your Plex account)\n" +
        "🎵 **Music:** {music}",
      "**🎬 Getting something added**\n" +
        "`/request movie` or `/request series`: search, tap a result, done. There's no approval queue, it just downloads.\n" +
        "`/request album`: the same for music.\n" +
        "I DM you a live tracker that shows how it's going, and message you when it's ready. `/requests` shows them all.\n" +
        "Requesting on {requests} works too: add your Discord user ID there (Profile → Settings → Notifications) to get the same tracker.",
      "**🎵 Music**\n" +
        "Listen in your browser or on your phone at {music}\n" +
        "`/aurral` gets you your own login for it.\n" +
        "Our music bot plays the library in voice channels: join one and type `/play` (its `/help` shows the rest).\n\n" +
        "**📺 Watching**\n" +
        "We recommend the **Plezy** app, including Watch Together for movie nights. Tap **About Plezy** below or type `/plezy`.",
      "**🛠️ Something wrong?**\n" +
        "`/redownload start`: glitchy file or bad audio? It swaps in a fresh copy and keeps you posted by DM.\n" +
        "`/missing`: an episode missing from a season, or a movie that never showed up? It finds it and downloads it.\n" +
        "`/report`: anything else (subtitles, wrong info…). You get a DM when it's fixed.\n" +
        "`/status`: is everything up?\n\n" +
        "**💡 Ideas**\n" +
        "`/suggest` an idea for the server, and 👍 the ones you like.\n\n" +
        "**🔔 Pings:** the button below (or `/pings`) picks what pings you.\n" +
        "Lost? `/help` shows everything I can do.",
    ],
  },
  plezy: {
    title: "📱 Watch with Plezy",
    sections: [
      "**Plezy** is an open-source app for watching our Plex library. You sign in with your normal Plex account, so the only thing that changes is the app. " +
        "It runs on Windows, Mac, Linux, iPhone and iPad, Android, Android TV and Fire TV. It's free on computers; the phone versions are a small purchase in the app stores.",
      "**Why it's better than the Plex app**\n" +
        "• **Plays almost anything directly.** It uses the mpv player, which handles more video, HDR and subtitle formats, so the server has to convert less and playback starts faster.\n" +
        "• **Better subtitles**, including styled anime subtitles (ASS/SSA).\n" +
        "• **Watch Together** for movie nights. Plex removed this from its own apps.\n" +
        "• **Offline downloads** for trips.\n" +
        "• **Just our library**, without Plex's free streaming channels mixed in.",
      "**Getting started**\n" +
        `1. Download it from **${PLEZY_URL}** (or the button below).\n` +
        "2. Sign in with your Plex account and pick our server.\n" +
        "3. For Watch Together, open **Settings → Watch Together Relay** and set it to {relay}. Start something, open a Watch Together room, and share its 6-character code in voice chat. Friends join with that code.",
      "Questions? Ask here. If a file plays badly, `/report` it and you'll get a DM when it's fixed.",
    ],
  },
};

const LABELS: Record<PostName, string> = { welcome: "welcome post", plezy: "Plezy guide" };

export interface PostVars {
  server: string;
  requests?: string;
  aurral?: string;
  relay?: string;
}

/** Fills in {server}, {requests}, {music}/{aurral} and {relay}; drops lines whose link isn't set. */
export function renderTokens(text: string, vars: PostVars): string {
  return text
    .split("\n")
    .filter((line) => !(line.includes("{requests}") && !vars.requests) && !(line.includes("{music}") && !vars.aurral))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replaceAll("{server}", vars.server)
    .replaceAll("{requests}", vars.requests ?? "")
    .replaceAll("{music}", vars.aurral ?? "")
    .replaceAll("{aurral}", vars.aurral ?? "ask an admin for the address")
    .replaceAll("{relay}", vars.relay ? `\`${vars.relay}\`` : "the default (leave it as it is)");
}

/** Total characters Discord counts toward the 6000-per-message embed limit. */
export function embedChars(title: string, sections: string[]): number {
  return title.length + sections.reduce((a, s) => a + s.length, 0);
}

export function renderPost(name: PostName, content: PostContent, vars: PostVars): LivePayload {
  const color = name === "plezy" ? 0xe5a00d : Colors.info;
  const sections = content.sections.map((s) => renderTokens(s, vars)).filter((s) => s.trim());
  const embeds = (sections.length ? sections : [" "]).map((text, idx) => {
    const e = new EmbedBuilder().setColor(color).setDescription(text);
    if (idx === 0) e.setTitle(renderTokens(content.title, vars).slice(0, 256));
    return e;
  });
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (name === "welcome") {
    if (vars.requests) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(vars.requests).setEmoji("🎬").setLabel("Request on the web"));
    if (vars.aurral) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(vars.aurral).setEmoji("🎵").setLabel("Music"));
    row.addComponents(
      new ButtonBuilder().setCustomId("optin:open").setEmoji("🔔").setLabel("Ping settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("posts:plezy").setEmoji("📱").setLabel("About Plezy").setStyle(ButtonStyle.Secondary),
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(PLEZY_URL).setLabel("Download Plezy"),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL("https://github.com/edde746/plezy").setLabel("Source code"),
    );
  }
  return { embeds, components: [row], allowedMentions: { parse: [] } };
}

export const posts: ModuleFactory = (ctx: AppContext) => {
  const { store, client, cfg } = ctx;
  const live: Record<PostName, LiveMessage> = {
    welcome: new LiveMessage(client, store, "welcome"),
    plezy: new LiveMessage(client, store, "plezy"),
  };
  const lastPublic = new Map<string, number>();

  const content = (name: PostName): PostContent => store.kvGet<PostContent>(`post.${name}`) ?? DEFAULT_POSTS[name];
  const vars = (): PostVars => ({
    server: client.guilds?.cache.get(cfg.guildId)?.name ?? "our server",
    requests: cfg.links.requests,
    aurral: cfg.links.aurral,
    relay: cfg.links.plezyRelay,
  });
  const payload = (name: PostName, c = content(name)) => renderPost(name, c, vars());

  async function refresh(name: PostName) {
    try {
      await live[name].update(payload(name));
    } catch (err) {
      log.warn(`posts: couldn't refresh the ${LABELS[name]}: ${(err as Error).message}`);
    }
  }

  // Links changed via /setup links → posts that mention them update themselves.
  ctx.bus.on("settings-changed", () => {
    void refresh("welcome");
    void refresh("plezy");
  });

  async function place(i: ChatInputCommandInteraction, name: PostName) {
    const channel = i.options.getChannel("channel", true);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (name === "welcome") {
      // The welcome post has a ping-settings button, so make sure the roles exist.
      await ctx.roles.ensure(i.guild!).catch((err) => log.warn(`posts: couldn't create ping roles yet: ${(err as Error).message}`));
    }
    const msg = await live[name].place(channel.id, payload(name));
    const hint = name === "welcome" ? "\nTip: pin it, and make the channel read-only for members." : "";
    await i.editReply(`✅ ${LABELS[name][0].toUpperCase()}${LABELS[name].slice(1)} posted in <#${msg.channelId}>. Edit the text any time with \`/setup edit post:${name}\`.${hint}`);
  }

  async function openEditor(i: ChatInputCommandInteraction) {
    const name = i.options.getString("post", true) as PostName;
    const c = store.kvGet<PostContent>(`post.${name}.draft`) ?? content(name);
    const modal = new ModalBuilder().setCustomId(`post:${name}`).setTitle(`Edit the ${LABELS[name]}`);
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("Title")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(256)
      .setRequired(true);
    if (c.title) title.setValue(c.title.slice(0, 256));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(title));
    for (let n = 0; n < MAX_SECTIONS; n++) {
      const input = new TextInputBuilder()
        .setCustomId(`s${n}`)
        .setLabel(`Section ${n + 1}${n === 0 ? "" : " (optional)"}`)
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(n === 0)
        .setPlaceholder("Markdown works: **bold**, *italics*, `code`, • bullets. Tokens: {server} {aurral} {relay}");
      const value = c.sections[n] ?? "";
      if (value) input.setValue(value.slice(0, 4000));
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }
    await i.showModal(modal);
  }

  async function saveEdit(i: ModalSubmitInteraction) {
    const name = i.customId.split(":")[1] as PostName;
    const next: PostContent = {
      title: i.fields.getTextInputValue("title").trim(),
      sections: Array.from({ length: MAX_SECTIONS }, (_, n) => i.fields.getTextInputValue(`s${n}`) ?? "").map((s) => s.trim()),
    };
    const rendered = payload(name, next);
    const size = embedChars(
      (rendered.embeds?.[0] as EmbedBuilder | undefined)?.data.title ?? "",
      (rendered.embeds ?? []).map((e) => (e as EmbedBuilder).data.description ?? ""),
    );
    if (size > MESSAGE_EMBED_LIMIT) {
      store.kvSet(`post.${name}.draft`, next);
      await i.reply({
        content: `⚠️ That's ${size.toLocaleString("en-US")} characters, and Discord allows ${MESSAGE_EMBED_LIMIT.toLocaleString("en-US")} per post. Your text is saved as a draft: run \`/setup edit post:${name}\` again and trim it.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    store.kvSet(`post.${name}`, next);
    store.kvDelete(`post.${name}.draft`);
    const updated = await live[name].update(rendered).catch((err) => {
      log.warn(`posts: update failed: ${(err as Error).message}`);
      return false;
    });
    const where = live[name].link(cfg.guildId);
    await i.reply({
      content: updated && where ? `✅ Saved and updated: ${where}` : `✅ Saved. Post it with \`/setup ${name} channel:#…\`. Preview:`,
      embeds: updated ? [] : rendered.embeds,
      flags: MessageFlags.Ephemeral,
    });
  }

  async function reset(i: ChatInputCommandInteraction) {
    const name = i.options.getString("post", true) as PostName;
    store.kvDelete(`post.${name}`);
    store.kvDelete(`post.${name}.draft`);
    await refresh(name);
    await i.reply({ content: `↩️ The ${LABELS[name]} is back to the built-in text.`, flags: MessageFlags.Ephemeral });
  }

  /** /plezy: everyone in the channel sees it. A short cooldown stops it being spammed. */
  async function plezyPublic(i: ChatInputCommandInteraction) {
    const last = lastPublic.get(i.channelId) ?? 0;
    if (Date.now() - last < PUBLIC_COOLDOWN_MS) {
      await i.reply({ ...payload("plezy"), flags: MessageFlags.Ephemeral, content: "It was posted here a moment ago (scroll up), so this copy is just for you:" });
      return;
    }
    lastPublic.set(i.channelId, Date.now());
    await i.reply(payload("plezy"));
  }

  async function plezyButton(i: MessageComponentInteraction) {
    await i.reply({ ...payload("plezy"), flags: MessageFlags.Ephemeral });
  }

  const postChoice = (b: { addChoices: (...c: Array<{ name: string; value: string }>) => unknown }) =>
    b.addChoices({ name: "Welcome post", value: "welcome" }, { name: "Plezy guide", value: "plezy" });

  return {
    name: "posts",
    // Redraw once at startup, so new built-in text and links show up after an update.
    start: () => {
      void refresh("welcome");
      void refresh("plezy");
    },
    commands: [{ name: "plezy", description: "Show everyone in this channel how to get Plezy and why it's better", execute: plezyPublic }],
    subcommands: [
      {
        ...SETUP,
        name: "welcome",
        description: "Post the welcome post in a channel (e.g. #start-here), or move it",
        build: (b) => b.addChannelOption((o) => o.setName("channel").setDescription("Where it lives").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
        execute: (i) => place(i, "welcome"),
      },
      {
        ...SETUP,
        name: "plezy",
        description: "Post the Plezy guide in a channel, or move it",
        build: (b) => b.addChannelOption((o) => o.setName("channel").setDescription("Where it lives").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
        execute: (i) => place(i, "plezy"),
      },
      {
        ...SETUP,
        name: "edit",
        description: "Edit the welcome post or Plezy guide (opens a form with the current text)",
        build: (b) => b.addStringOption((o) => postChoice(o.setName("post").setDescription("Which post").setRequired(true)) as typeof o),
        execute: openEditor,
      },
      {
        ...SETUP,
        name: "reset",
        description: "Put the welcome post or Plezy guide back to the built-in text",
        build: (b) => b.addStringOption((o) => postChoice(o.setName("post").setDescription("Which post").setRequired(true)) as typeof o),
        execute: reset,
      },
    ],
    components: { posts: plezyButton },
    modals: { post: saveEdit },
  };
};
