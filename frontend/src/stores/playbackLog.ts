import { defineStore } from "pinia";
import { parseTimecodeToMs, resolveSegmentAt, type PlayableSegment } from "../composables/useLocalSegmentPlayback";
import type { LogEntry, LogLevel } from "./logs";

/**
 * The Playback page's event log: what is being played out, and when it changed.
 *
 * Two kinds of entry are shown together. The backend's own log already records the things that
 * happen *to* a transmission — going on air, a cut, a clip booked — and those come from
 * /api/logs, filtered to the sources that concern playback. What it does not record is what is
 * playing at any given instant, because that changes every segment and writing a line per segment
 * to a shared log file would bury everything else in it. Those entries are made here instead, from
 * the deck's own state, and live only for the session.
 *
 * Which segment a timecode belongs to is answered by resolveSegmentAt — the same function the deck
 * positions its video with. Anything else would let the log name one segment while another is on
 * screen.
 */

/** Sources from the shared backend log that describe playout rather than capture. */
const PLAYBACK_SOURCES = ["TX", "AirEdit", "Playback"];

/** Enough to cover a long session's transitions without growing without bound. */
const MAX_CLIENT_ENTRIES = 400;

/**
 * `delaySeconds` is how far behind the generator the video was at the moment the entry was made —
 * the gap between the playout timecode on the line and the actual time of day. Null on entries the
 * backend wrote, which record when something was *asked for* rather than when it reached air, and
 * so have no playout position to be behind by.
 */
export type PlaybackLogEntry = LogEntry & {
  origin: "local" | "server";
  delaySeconds: number | null;
};

type PlaybackState = {
  folder: string;
  /** Where playout has reached, as milliseconds since local midnight. */
  atMsSinceMidnight: number | null;
  /** "live" when watching the SDI loopback, "local" when playing files from disk. */
  source: "live" | "local";
  isTransmitting: boolean;
  /** How far the video is behind the generator right now, in seconds. */
  delaySeconds: number;
};

export const usePlaybackLogStore = defineStore("playbackLog", {
  state: () => ({
    clientEntries: [] as PlaybackLogEntry[],
    serverEntries: [] as PlaybackLogEntry[],
    segments: [] as PlayableSegment[],
    /** The segment playout is inside right now, or null in a gap. */
    currentSegment: null as PlayableSegment | null,
    currentOffsetSeconds: 0,
    currentTimecode: "",
    /** The gap between what is playing and live, carried onto every entry made from here. */
    delaySeconds: 0,
    /** What is due after the current segment, and the timecode it is due at. */
    nextUp: null as { fileName: string; timecode: string } | null,
    loadedFolder: "",
    fps: 25,
    /** Whether the backend's timecode is the generator's or a fallback — see timecodeMasterService. */
    timecodeLockState: null as string | null,
    nextId: 1,
  }),
  getters: {
    /** Both sources in one time-ordered console, newest last. */
    entries(state): PlaybackLogEntry[] {
      return [...state.serverEntries, ...state.clientEntries].sort((a, b) => {
        const left = a.timestamp ? Date.parse(a.timestamp) : 0;
        const right = b.timestamp ? Date.parse(b.timestamp) : 0;
        return left - right;
      });
    },
  },
  actions: {
    record(source: string, message: string, level: LogLevel = "info", tc: string | null = null) {
      this.clientEntries.push({
        id: this.nextId++,
        timestamp: new Date().toISOString(),
        level,
        tc,
        source,
        message,
        origin: "local",
        // Stamped from the store's current figure rather than passed in by every caller, so no
        // entry can be written that forgets to say how far behind the video was.
        delaySeconds: this.delaySeconds,
      });

      if (this.clientEntries.length > MAX_CLIENT_ENTRIES) {
        this.clientEntries.splice(0, this.clientEntries.length - MAX_CLIENT_ENTRIES);
      }
    },

    async loadSegments(folder: string) {
      if (!folder) {
        this.segments = [];
        this.loadedFolder = "";
        return;
      }

      try {
        const response = await fetch(`/api/recording-sessions/${encodeURIComponent(folder)}/segments`);
        const result = await response.json();
        if (!response.ok) return;
        this.segments = (result as PlayableSegment[]).filter((segment) => segment.kind === "mp4");
        this.loadedFolder = folder;
      } catch {
        // Transient — the next tick retries, and the last known list stays usable meanwhile.
      }
    },

    async refreshServerEntries() {
      try {
        const response = await fetch("/api/logs?limit=200");
        if (!response.ok) return;
        const result = (await response.json()) as LogEntry[];
        this.serverEntries = result
          .filter((entry) => PLAYBACK_SOURCES.includes(entry.source))
          .map((entry) => ({ ...entry, origin: "server" as const, delaySeconds: null }));
      } catch {
        // Same — hold the last known events rather than blanking the console.
      }
    },

    /**
     * Fed by the deck on its own tick. Records a line only when something actually changes, so the
     * console reads as a list of events rather than a stream of the same fact restated.
     */
    apply(state: PlaybackState) {
      if (state.folder !== this.loadedFolder) {
        this.loadSegments(state.folder);
        if (state.folder) this.record("Playback", `Folder selected — ${state.folder}`);
      }

      if (state.atMsSinceMidnight === null) {
        if (this.currentSegment) {
          this.currentSegment = null;
          this.currentTimecode = "";
        }
        return;
      }

      this.currentTimecode = formatTimecode(state.atMsSinceMidnight, this.fps);
      this.delaySeconds = state.delaySeconds;

      const resolved = resolveSegmentAt(this.segments, state.atMsSinceMidnight, this.fps);
      const previous = this.currentSegment?.fileName ?? null;
      const next = resolved?.segment.fileName ?? null;

      this.currentSegment = resolved?.segment ?? null;
      this.currentOffsetSeconds = resolved?.offsetSeconds ?? 0;

      const upcoming = nextSegmentAfter(this.segments, state.atMsSinceMidnight, this.fps);
      this.nextUp = upcoming
        ? { fileName: upcoming.segment.fileName, timecode: formatTimecode(upcoming.startMs, this.fps) }
        : null;

      if (next === previous) return;

      // What is queued behind whatever just changed. Stated on the same line rather than as an
      // entry of its own: the queue only moves when the clip does, so a separate line would say
      // the same thing twice and at the same instant.
      const queued = this.nextUp
        ? ` · next ${this.nextUp.fileName} at ${this.nextUp.timecode}`
        : " · nothing queued after this";

      if (next) {
        this.record(
          "Playback",
          `${state.source === "local" ? "Playing" : "On air"} ${next}`
            + ` — ${describeDelay(state.delaySeconds)} behind the generator${queued}`,
          "info",
          this.currentTimecode,
        );
      } else if (previous) {
        // A genuine gap between segments, which is worth a line: it is why the picture stopped.
        this.record(
          "Playback",
          `No recorded material at this timecode${this.nextUp ? ` — resumes ${this.nextUp.fileName} at ${this.nextUp.timecode}` : " — nothing further recorded"}`,
          "warn",
          this.currentTimecode,
        );
      }
    },

    clear() {
      this.clientEntries = [];
    },
  },
});

/**
 * The segment due next after `targetMs`, and the timecode it starts at.
 *
 * Found by earliest start rather than by list order: the listing is ordered by file creation time,
 * which is close to but not the same as recorded timecode, and it is the timecode an operator is
 * being told to expect. Compared on the raw time of day, so a session running through midnight
 * reports nothing next rather than something wrong — the honest answer for a case this cannot see
 * past.
 */
function nextSegmentAfter(segments: PlayableSegment[], targetMs: number, fps: number) {
  let best: { segment: PlayableSegment; startMs: number } | null = null;

  for (const segment of segments) {
    const startMs = parseTimecodeToMs(segment.startTimecode, segment.frameRate || fps);
    if (startMs === null || startMs <= targetMs) continue;
    if (!best || startMs < best.startMs) best = { segment, startMs };
  }

  return best;
}

/** Seconds as "N.Ns" under a minute and "m:ss" above it, which is how an operator reads a delay. */
export function describeDelay(seconds: number): string {
  if (!(seconds > 0)) return "live";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Milliseconds since midnight to HH:MM:SS:FF, matching the deck's own on-screen readout. */
function formatTimecode(msSinceMidnight: number, fps: number): string {
  const pad = (value: number) => String(Math.trunc(value)).padStart(2, "0");
  const totalMs = ((msSinceMidnight % 86_400_000) + 86_400_000) % 86_400_000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const frames = Math.floor(((totalMs % 1000) / 1000) * Math.max(1, fps));
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(frames)}`;
}
