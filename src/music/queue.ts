/** Pure queue logic for the music player (kept separate so it's unit-testable). */
import type { SubsonicSong } from "../services/subsonic.js";

export interface Track {
  song: SubsonicSong;
  requestedBy: string;
  /** Added automatically by radio mode. */
  radio?: boolean;
}

export const MAX_QUEUE = 500;

export class TrackQueue {
  private items: Track[] = [];

  get length(): number {
    return this.items.length;
  }

  list(): readonly Track[] {
    return this.items;
  }

  /** Adds tracks at the end (or right after the current one with `next`). Returns how many fit. */
  add(tracks: Track[], next = false): number {
    const room = Math.max(0, MAX_QUEUE - this.items.length);
    const accepted = tracks.slice(0, room);
    if (next) this.items.unshift(...accepted);
    else this.items.push(...accepted);
    return accepted.length;
  }

  shift(): Track | undefined {
    return this.items.shift();
  }

  clear(): void {
    this.items = [];
  }

  /** Drops queued radio picks (when radio is switched off). */
  clearRadio(): void {
    this.items = this.items.filter((t) => !t.radio);
  }

  shuffle(rand: () => number = Math.random): void {
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    }
  }

  /** Total queued time in seconds (unknown durations count as 0). */
  duration(): number {
    return this.items.reduce((a, t) => a + (t.song.duration ?? 0), 0);
  }
}

export function fmtDuration(sec: number | undefined): string {
  if (!sec || sec < 0) return "?:??";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function songLabel(s: SubsonicSong): string {
  return `${s.title}${s.artist ? ` — ${s.artist}` : ""}`;
}
