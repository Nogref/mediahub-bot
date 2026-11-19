/**
 * One voice session: joins a voice channel, plays the queue from the Subsonic
 * server and keeps a single "now playing" message up to date in the voice
 * channel's text chat. Audio arrives already Opus-encoded (format=opus), so
 * the bot does no transcoding and needs no ffmpeg.
 */
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type VoiceBasedChannel,
} from "discord.js";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Colors, truncate } from "../core/discord.js";
import type { LivePayload } from "../core/liveMessage.js";
import { log } from "../core/logger.js";
import type { SubsonicClient } from "../services/subsonic.js";
import { TrackQueue, fmtDuration, songLabel, type Track } from "./queue.js";

const RADIO_BATCH = 20;
const RADIO_LOW_WATER = 5;

/** Where the now-playing card goes (a pinned board, or the voice channel's chat). */
export type NowPlayingDisplay = (payload: LivePayload, ended: boolean) => Promise<void>;

export class MusicSession {
  readonly queue = new TrackQueue();
  current?: Track;
  radio = false;
  voiceChannelId?: string;
  private player: AudioPlayer;
  private connection?: VoiceConnection;
  private resource?: AudioResource<Track>;
  private idleTimer?: NodeJS.Timeout;
  private renderTimer?: NodeJS.Timeout;
  private failures = 0;
  private destroyed = false;

  constructor(
    private readonly subsonic: SubsonicClient,
    private readonly idleMinutes: number,
    private readonly display: NowPlayingDisplay,
    private readonly onEnd: () => void,
  ) {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.player.on(AudioPlayerStatus.Idle, () => void this.advance());
    this.player.on("error", (err) => log.warn(`music: playback error on "${this.current?.song.title}": ${err.message}`));
  }

  get paused(): boolean {
    return this.player.state.status === AudioPlayerStatus.Paused || this.player.state.status === AudioPlayerStatus.AutoPaused;
  }

  get playing(): boolean {
    return this.player.state.status !== AudioPlayerStatus.Idle;
  }

  async join(channel: VoiceBasedChannel): Promise<void> {
    if (this.connection && this.voiceChannelId === channel.id) return;
    this.connection?.destroy();
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: true,
    });
    this.connection = connection;
    this.voiceChannelId = channel.id;
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Moved to another channel → reconnects on its own; kicked → give up.
      try {
        await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)]);
      } catch {
        void this.destroy("Disconnected from voice");
      }
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      void this.destroy();
      throw new Error("Couldn't connect to the voice channel (check I have Connect and Speak there)", { cause: err });
    }
    connection.subscribe(this.player);
  }

  /** Queues tracks; starts playing if nothing is. */
  async enqueue(tracks: Track[], next = false): Promise<number> {
    const added = this.queue.add(tracks, next);
    this.clearIdle();
    if (!this.playing) await this.advance();
    else await this.renderNowPlaying();
    return added;
  }

  async setRadio(on: boolean, requestedBy: string): Promise<void> {
    this.radio = on;
    if (!on) {
      this.queue.clearRadio();
    } else {
      await this.topUpRadio(requestedBy);
      if (!this.playing) await this.advance();
    }
    await this.renderNowPlaying();
  }

  private async topUpRadio(requestedBy = "radio"): Promise<void> {
    if (!this.radio || this.queue.length >= RADIO_LOW_WATER) return;
    try {
      const songs = await this.subsonic.randomSongs(RADIO_BATCH);
      this.queue.add(songs.map((song) => ({ song, requestedBy, radio: true })));
    } catch (err) {
      log.warn(`music: radio refill failed: ${(err as Error).message}`);
    }
  }

  togglePause(): boolean {
    if (this.paused) this.player.unpause();
    else this.player.pause();
    void this.renderNowPlaying();
    return this.paused;
  }

  skip(): void {
    this.player.stop(true); // → Idle → advance()
  }

  shuffle(): void {
    this.queue.shuffle();
    void this.renderNowPlaying();
  }

  /** Plays the next track, skipping ones that fail to start. */
  private async advance(): Promise<void> {
    if (this.destroyed) return;
    this.resource?.playStream.destroy();
    this.resource = undefined;
    await this.topUpRadio();
    const next = this.queue.shift();
    this.current = next;
    if (!next) {
      await this.renderNowPlaying();
      this.armIdle();
      return;
    }
    try {
      this.resource = await this.open(next);
      this.player.play(this.resource);
      this.failures = 0;
      await this.renderNowPlaying();
    } catch (err) {
      log.warn(`music: couldn't play "${next.song.title}": ${(err as Error).message}`);
      if (++this.failures >= 5) {
        await this.destroy("Stopped after several tracks failed to play. Is the Subsonic server reachable and set to transcode Opus?");
        return;
      }
      await this.advance();
    }
  }

  private async open(track: Track): Promise<AudioResource<Track>> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000); // connect/headers only; the body streams for as long as the song lasts
    let res: Response;
    try {
      res = await fetch(this.subsonic.streamUrl(track.song.id), { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) throw new Error(`stream returned HTTP ${res.status}`);
    if ((res.headers.get("content-type") ?? "").includes("json")) throw new Error("server returned an error instead of audio");
    const { stream, type } = await demuxProbe(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>));
    if (type !== StreamType.OggOpus && type !== StreamType.WebmOpus) {
      stream.destroy();
      throw new Error("server didn't send Opus audio (enable Opus transcoding on the Subsonic server)");
    }
    return createAudioResource(stream, { inputType: type, metadata: track });
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Leaves after MUSIC_IDLE_MINUTES with nothing to play (or nobody listening). */
  armIdle(reason = "Queue finished") {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.destroy(`${reason}, so I left the channel.`), this.idleMinutes * 60_000);
  }

  noteListeners(count: number) {
    if (count === 0) this.armIdle("Everyone left");
    else if (this.playing) this.clearIdle();
  }

  private controls(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("player:pause").setEmoji(this.paused ? "▶️" : "⏸️").setLabel(this.paused ? "Resume" : "Pause").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("player:skip").setEmoji("⏭️").setLabel("Skip").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("player:radio").setEmoji("📻").setLabel(this.radio ? "Radio on" : "Radio").setStyle(this.radio ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("player:queue").setEmoji("📜").setLabel("Queue").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("player:stop").setEmoji("⏹️").setLabel("Stop").setStyle(ButtonStyle.Danger),
    );
  }

  /** Coalesces bursts of changes (queueing an album, pause/resume) into one edit. */
  private renderNowPlaying(): Promise<void> {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    return new Promise((resolve) => {
      this.renderTimer = setTimeout(() => {
        this.renderTimer = undefined;
        void this.buildAndShow().finally(resolve);
      }, 750);
    });
  }

  private async buildAndShow(final?: string): Promise<void> {
    const t = this.current;
    const embed = new EmbedBuilder().setColor(Colors.plex);
    const files: AttachmentBuilder[] = [];
    if (final || !t) {
      embed
        .setColor(Colors.muted)
        .setTitle(final ? "⏹️ Music stopped" : "🎶 Queue finished")
        .setDescription(final ?? `Add more with \`/music play\`, or I'll leave in ${this.idleMinutes} min.`);
    } else {
      const s = t.song;
      const upNext = this.queue
        .list()
        .slice(0, 3)
        .map((q, i) => `${i + 1}. ${truncate(songLabel(q.song), 70)}`)
        .join("\n");
      embed
        .setAuthor({ name: this.voiceChannelId ? "Now playing in voice" : "Now playing" })
        .setTitle(truncate(`${this.paused ? "⏸️" : "🎶"} ${s.title}`, 256))
        .setDescription(
          [[s.artist && `**${s.artist}**`, s.album && `*${s.album}*`, fmtDuration(s.duration)].filter(Boolean).join(" · "), this.voiceChannelId ? `🔊 <#${this.voiceChannelId}>` : ""]
            .filter(Boolean)
            .join("\n"),
        )
        .setFooter({ text: `${t.radio ? "📻 Radio pick" : `Requested by ${t.requestedBy}`}${this.queue.length ? ` · ${this.queue.length} in queue` : ""}` });
      if (upNext) embed.addFields({ name: "Up next", value: upNext });
      if (s.coverArt) {
        try {
          files.push(new AttachmentBuilder(await this.subsonic.coverArt(s.coverArt, 300), { name: "cover.jpg" }));
          embed.setThumbnail("attachment://cover.jpg");
        } catch {
          /* no cover is fine */
        }
      }
    }
    const ended = Boolean(final);
    try {
      await this.display({ embeds: [embed], files, components: final || !t ? [] : [this.controls()], allowedMentions: { parse: [] } }, ended);
    } catch (err) {
      log.warn(`music: couldn't update the now-playing card: ${(err as Error).message}`);
    }
  }

  async destroy(reason = "Stopped"): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdle();
    this.queue.clear();
    this.player.stop(true);
    this.resource?.playStream.destroy();
    try {
      this.connection?.destroy();
    } catch {
      /* already gone */
    }
    if (this.renderTimer) clearTimeout(this.renderTimer);
    await this.buildAndShow(reason).catch(() => undefined);
    this.onEnd();
  }
}
