/**
 * /music play|radio|queue|skip|shuffle|stop: streams your own library from a
 * Subsonic server (Aurral's built-in one, or Navidrome) into a voice channel.
 * Gated behind the Music opt-in. Controls work for anyone in the same voice
 * channel (and admins).
 */
import {
  EmbedBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type BaseInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type MessageComponentInteraction,
  type SendableChannels,
  type VoiceBasedChannel,
} from "discord.js";
import { Colors, truncate } from "../core/discord.js";
import { log } from "../core/logger.js";
import type { ModuleFactory, SubcommandDef } from "../core/module.js";
import { TtlCache } from "../core/ttlCache.js";
import { MusicSession } from "../music/session.js";
import { fmtDuration, songLabel, type Track } from "../music/queue.js";
import type { SubsonicPlaylist, SubsonicSong } from "../services/subsonic.js";

const PARENT = { parent: "music", parentDescription: "Play music from the server's library in voice", gate: "music" } as const;

export const music: ModuleFactory = ({ services, cfg, client, access }) => {
  const subsonic = services.subsonic;
  if (!subsonic || !cfg.subsonic) return null;

  let session: MusicSession | undefined;
  const playlistCache = new TtlCache<string, SubsonicPlaylist[]>(5 * 60_000);

  const memberVoice = (i: BaseInteraction): VoiceBasedChannel | null => (i.member as GuildMember | null)?.voice?.channel ?? null;

  /** Controls are for people listening with the bot (or admins). */
  function canControl(i: BaseInteraction): string | null {
    if (!session) return "Nothing is playing.";
    if (access.isAdmin(i)) return null;
    return memberVoice(i)?.id === session.voiceChannelId ? null : "Join the voice channel I'm in to control the music.";
  }

  async function resolve(query: string): Promise<{ tracks: SubsonicSong[]; label: string }> {
    const [kind, ...rest] = query.split(":");
    const id = rest.join(":");
    switch (kind) {
      case "s": {
        const s = await subsonic!.song(id);
        return { tracks: [s], label: `**${songLabel(s)}**` };
      }
      case "a": {
        const a = await subsonic!.album(id);
        return { tracks: a.song, label: `the album **${a.name}**${a.artist ? ` by ${a.artist}` : ""} (${a.song.length} tracks)` };
      }
      case "p": {
        const p = await subsonic!.playlist(id);
        return { tracks: p.entry, label: `the playlist **${p.name}** (${p.entry.length} tracks)` };
      }
      case "ar": {
        const songs = await subsonic!.topSongs(id, 25);
        return { tracks: songs, label: `top songs by **${id}** (${songs.length})` };
      }
      default: {
        // Typed without picking a suggestion: best song match.
        const r = await subsonic!.search(query, { song: 1, album: 0, artist: 0 });
        const s = r.songs[0];
        return s ? { tracks: [s], label: `**${songLabel(s)}**` } : { tracks: [], label: "" };
      }
    }
  }

  async function ensureSession(i: ChatInputCommandInteraction | MessageComponentInteraction): Promise<MusicSession | string> {
    const voice = memberVoice(i);
    if (!voice) return "Join a voice channel first, then try again.";
    if (session && session.voiceChannelId !== voice.id && session.playing && !access.isAdmin(i)) {
      return `I'm already playing in <#${session.voiceChannelId}>. Join there, or stop it first.`;
    }
    const me = voice.guild.members.me;
    const perms = me ? voice.permissionsFor(me) : null;
    if (perms && (!perms.has("Connect") || !perms.has("Speak"))) return `I need **Connect** and **Speak** permissions in <#${voice.id}>.`;
    session ??= new MusicSession(subsonic!, cfg.subsonic!.idleMinutes, () => {
      session = undefined;
    });
    await session.join(voice, i.channel?.isSendable() ? (i.channel as SendableChannels) : undefined);
    return session;
  }

  async function play(i: ChatInputCommandInteraction) {
    const query = i.options.getString("query", true).trim();
    const next = i.options.getBoolean("next") ?? false;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const { tracks, label } = await resolve(query);
    if (!tracks.length) {
      await i.editReply(`🔍 Nothing in the library matches **${truncate(query, 80)}**. Pick from the suggestions as you type.`);
      return;
    }
    const s = await ensureSession(i);
    if (typeof s === "string") return void (await i.editReply(s));
    const wasPlaying = s.playing;
    const added = await s.enqueue(
      tracks.map((song): Track => ({ song, requestedBy: i.user.displayName })),
      next,
    );
    const capped = added < tracks.length ? ` (queue is full, added ${added})` : "";
    await i.editReply(wasPlaying ? `➕ Queued ${label}${next ? " to play next" : ""}${capped}.` : `▶️ Playing ${label} in <#${s.voiceChannelId}>${capped}.`);
  }

  async function radio(i: ChatInputCommandInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (session?.radio) {
      const denied = canControl(i);
      if (denied) return void (await i.editReply(denied));
      await session.setRadio(false, i.user.displayName);
      return void (await i.editReply("📻 Radio off. The rest of your queue keeps playing."));
    }
    const s = await ensureSession(i);
    if (typeof s === "string") return void (await i.editReply(s));
    await s.setRadio(true, i.user.displayName);
    await i.editReply(`📻 Radio on: random songs from the library in <#${s.voiceChannelId}> until someone stops it.`);
  }

  function queueEmbed(): EmbedBuilder {
    const e = new EmbedBuilder().setColor(Colors.plex).setTitle("📜 Queue");
    if (!session?.current) return e.setDescription("Nothing is playing.");
    const list = session.queue.list();
    const lines = list.slice(0, 15).map((t, idx) => `${idx + 1}. ${truncate(songLabel(t.song), 80)} · ${fmtDuration(t.song.duration)}${t.radio ? " 📻" : ""}`);
    const more = list.length > 15 ? `\n…and ${list.length - 15} more` : "";
    return e
      .setDescription(`**Now:** ${truncate(songLabel(session.current.song), 100)}\n\n${lines.join("\n") || "*Nothing queued.*"}${more}`)
      .setFooter({ text: `${list.length} queued · ${fmtDuration(session.queue.duration())}${session.radio ? " · radio on" : ""}` });
  }

  async function control(i: ChatInputCommandInteraction | MessageComponentInteraction, action: string) {
    if (action === "queue") return void (await i.reply({ embeds: [queueEmbed()], flags: MessageFlags.Ephemeral }));
    const denied = canControl(i);
    if (denied) return void (await i.reply({ content: denied, flags: MessageFlags.Ephemeral }));
    const s = session!;
    const ack = async (text: string) => {
      if (i.isMessageComponent()) await i.deferUpdate();
      else await i.reply({ content: text, flags: MessageFlags.Ephemeral });
    };
    switch (action) {
      case "pause":
        return ack(s.togglePause() ? "⏸️ Paused." : "▶️ Resumed.");
      case "skip":
        s.skip();
        return ack("⏭️ Skipped.");
      case "shuffle":
        s.shuffle();
        return ack("🔀 Shuffled the queue.");
      case "radio":
        await s.setRadio(!s.radio, i.user.displayName);
        return ack(s.radio ? "📻 Radio on." : "📻 Radio off.");
      case "stop":
        await s.destroy(`Stopped by ${i.user.displayName}.`);
        return ack("⏹️ Stopped and left the channel.");
    }
  }

  async function autocomplete(i: AutocompleteInteraction) {
    const typed = i.options.getFocused().trim();
    if (typed.length < 2) return void (await i.respond([]));
    const [r, lists] = await Promise.all([
      subsonic!.search(typed, { song: 10, album: 6, artist: 4 }),
      playlistCache.get("all") ? Promise.resolve(playlistCache.get("all")!) : subsonic!.playlists().catch(() => [] as SubsonicPlaylist[]),
    ]);
    playlistCache.set("all", lists);
    const lower = typed.toLowerCase();
    const choices = [
      ...r.artists.map((a) => ({ name: `👤 ${a.name} (top songs)`, value: `ar:${a.name}` })),
      ...r.albums.map((a) => ({ name: `💿 ${a.name}${a.artist ? ` — ${a.artist}` : ""}`, value: `a:${a.id}` })),
      ...lists.filter((p) => p.name.toLowerCase().includes(lower)).map((p) => ({ name: `📃 ${p.name} (playlist)`, value: `p:${p.id}` })),
      ...r.songs.map((s) => ({ name: `🎵 ${songLabel(s)}`, value: `s:${s.id}` })),
    ]
      .filter((c) => c.value.length <= 100)
      .map((c) => ({ ...c, name: truncate(c.name, 100) }))
      .slice(0, 25);
    await i.respond(choices);
  }

  const sub = (name: string, description: string, execute: SubcommandDef["execute"], extra: Partial<SubcommandDef> = {}): SubcommandDef => ({
    ...PARENT,
    name,
    description,
    execute,
    ...extra,
  });

  return {
    name: "music",
    subcommands: [
      sub("play", "Play a song, album, artist or playlist from the library", play, {
        build: (b) =>
          b
            .addStringOption((o) => o.setName("query").setDescription("Start typing a song, album, artist or playlist").setRequired(true).setAutocomplete(true))
            .addBooleanOption((o) => o.setName("next").setDescription("Put it at the front of the queue")),
        autocomplete,
      }),
      sub("radio", "Toggle radio: endless random songs from the library", radio),
      sub("queue", "Show what's playing and what's next", (i) => control(i, "queue")),
      sub("skip", "Skip the current song", (i) => control(i, "skip")),
      sub("shuffle", "Shuffle the queue", (i) => control(i, "shuffle")),
      sub("stop", "Stop, clear the queue and leave the voice channel", (i) => control(i, "stop")),
    ],
    components: {
      player: async (i) => {
        const denied = access.check(i, "music");
        if (denied) return void (await i.reply({ content: denied, flags: MessageFlags.Ephemeral }));
        await control(i, i.customId.split(":")[1]);
      },
    },
    start: () => {
      // Leave when nobody's left listening.
      client.on("voiceStateUpdate", (oldState, newState) => {
        if (!session?.voiceChannelId) return;
        if (oldState.channelId !== session.voiceChannelId && newState.channelId !== session.voiceChannelId) return;
        const channel = (newState.guild.channels.cache.get(session.voiceChannelId) ?? null) as VoiceBasedChannel | null;
        const listeners = channel?.members.filter((m) => !m.user.bot).size ?? 0;
        session.noteListeners(listeners);
      });
      log.info("music: Subsonic streaming enabled");
    },
    stop: async () => {
      await session?.destroy("The bot is restarting.");
    },
  };
};
