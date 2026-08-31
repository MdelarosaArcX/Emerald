import { ref, shallowRef, type Ref } from "vue";

/**
 * Plays a session's recorded files from disk, positioned by timecode.
 *
 * The Playback deck's preview normally watches a live SDI input over WebRTC. When no RX port is
 * selected there is no live signal to watch, so this stands in: it resolves the deck's on-air
 * timecode against each segment's own stored `startTimecode` and plays the file that actually
 * covers that instant, seeked to the right offset inside it. What you see therefore lines up with
 * the same clock the deck already displays, rather than being an independent "play from the top".
 *
 * Positioning reads `startTimecode` (the generator's clock, stamped at reconciliation) rather than
 * `createdAt` (this machine's raw wall clock, which drifts from it) — see the comment on
 * /api/recording-sessions/:folder/segments in server.js for why those two are not interchangeable.
 */

const DAY_MS = 86_400_000;
/**
 * Re-seek only past this much drift. A seek is visibly a jump, so correcting every small wobble
 * would look worse than the wobble does — the file and the clock both advance at 1x, so between
 * corrections they only separate by the video element's own rate error.
 */
const RESYNC_THRESHOLD_SECONDS = 0.75;
/**
 * Also how long a segment boundary can stay frozen before the next file is loaded, which is why
 * this is well under a second. The work per tick is arithmetic over the segment list — cheap
 * enough to run four times a second even for a session with hundreds of segments.
 */
const RESYNC_INTERVAL_MS = 250;

export type PlayableSegment = {
  fileName: string;
  kind: string;
  url: string;
  startTimecode: string | null;
  frameRate: number | null;
  durationSeconds: number | null;
};

type StartOptions = {
  /** The folder to play out of. */
  folder: string;
  /** Where to position, as milliseconds since local midnight — read fresh on every resync tick. */
  targetMs: () => number;
  /** Frame rate to parse a segment's timecode with when the segment itself does not carry one. */
  fallbackFps: () => number;
  /** Stands in for the still-recording last segment, whose duration cannot be probed yet. */
  fallbackSegmentSeconds: () => number;
};

/** HH:MM:SS:FF to milliseconds since local midnight. Mirrors backend services/timecodeFormat.js. */
export function parseTimecodeToMs(timecode: string | null, fps: number): number | null {
  if (typeof timecode !== "string") return null;
  const match = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(timecode.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, frames] = match.map(Number);
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + (frames / fps) * 1000;
}

/**
 * Shortest signed distance between two times-of-day, so a recording that straddles midnight reads
 * as "a few seconds apart" rather than "almost a whole day apart".
 */
function wrapDelta(deltaMs: number): number {
  if (deltaMs > DAY_MS / 2) return deltaMs - DAY_MS;
  if (deltaMs < -DAY_MS / 2) return deltaMs + DAY_MS;
  return deltaMs;
}

/**
 * A freshly assigned src has no duration yet, and a seek issued before the metadata arrives is
 * dropped on the floor — so hold the offset until the element can actually honour it, otherwise
 * every segment change would start playing from zero instead of from the timecode.
 */
function seekWhenReady(element: HTMLVideoElement, offsetSeconds: number): void {
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
    element.currentTime = offsetSeconds;
    return;
  }

  element.addEventListener(
    "loadedmetadata",
    () => { element.currentTime = offsetSeconds; },
    { once: true },
  );
}

/**
 * Which segment covers `targetMs`, and how far into it that instant falls. Null when the timecode
 * lands outside everything recorded — before the session started, after it ended, or inside a gap
 * between segments.
 *
 * Exported because more than one thing needs to answer "which segment is this timecode in", and two
 * implementations of that question drift apart: the playback deck positions video by it, and the
 * playback log reports it. They have to agree, or the log describes a segment other than the one on
 * screen.
 */
export function resolveSegmentAt(
  segments: PlayableSegment[],
  targetMs: number,
  fallbackFps = 25,
  fallbackSegmentSeconds = 120,
): { segment: PlayableSegment; offsetSeconds: number } | null {
  const rows = segments
    .map((segment) => ({
      segment,
      startMs: parseTimecodeToMs(segment.startTimecode, segment.frameRate || fallbackFps),
    }))
    .filter((row): row is { segment: PlayableSegment; startMs: number } => row.startMs !== null);

  // Walked newest-first so that where two segments overlap — which they routinely do, each file's
  // duration slightly exceeding the interval between their start timecodes — the newer one wins.
  // Both copies hold the same instant, so either shows the right picture; picking the newer is what
  // LiveEdit's timeline does with the same material (placeLiveSegment ends the previous clip where
  // the next begins), and resolving a timecode to the same file in both places keeps the two
  // genuinely frame-identical rather than merely equivalent.
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const next = rows[index + 1];
    // The still-recording last segment cannot be probed, so its duration comes back null. The next
    // segment's start is the exact answer when there is one; the recorder's configured segment
    // length is the estimate when there is not.
    const durationMs = row.segment.durationSeconds !== null
      ? row.segment.durationSeconds * 1000
      : next
        ? wrapDelta(next.startMs - row.startMs)
        : fallbackSegmentSeconds * 1000;

    const offsetMs = wrapDelta(targetMs - row.startMs);
    if (offsetMs >= 0 && offsetMs < durationMs) {
      return { segment: row.segment, offsetSeconds: offsetMs / 1000 };
    }
  }

  return null;
}

export function useLocalSegmentPlayback(video: Ref<HTMLVideoElement | null>) {
  const segments = shallowRef<PlayableSegment[]>([]);
  const activeSegment = shallowRef<PlayableSegment | null>(null);
  /** Says what it is doing (or why it is not) — surfaced in the deck's preview overlay. */
  const message = ref("");
  const isEngaged = ref(false);

  let options: StartOptions | null = null;
  let resyncHandle: number | null = null;
  let loadedFolder = "";

  async function loadSegments(folder: string): Promise<void> {
    if (!folder) {
      segments.value = [];
      loadedFolder = "";
      return;
    }

    try {
      const response = await fetch(`/api/recording-sessions/${encodeURIComponent(folder)}/segments`);
      const result = await response.json();
      if (!response.ok) throw new Error(result?.message || "Unable to list segments.");
      // .ts is the live TX leg — never reconciled into the segment table, so it carries no
      // startTimecode to position by (see the endpoint's own note). Only the mp4s are placeable.
      segments.value = (result as PlayableSegment[]).filter((segment) => segment.kind === "mp4");
      loadedFolder = folder;
    } catch (error) {
      message.value = (error as Error).message;
    }
  }

  /**
   * Which segment covers `targetMs` — see resolveSegmentAt, shared so that anything else reporting
   * "what is playing now" resolves a timecode exactly the way playback does.
   */
  function resolve(targetMs: number) {
    return resolveSegmentAt(
      segments.value,
      targetMs,
      options?.fallbackFps() || 25,
      options?.fallbackSegmentSeconds() || 120,
    );
  }

  function resync(): void {
    const element = video.value;
    if (!element || !options) return;

    if (!segments.value.length) {
      message.value = loadedFolder
        ? "No recorded segments in this folder"
        : "Select a recording folder to play back";
      return;
    }

    const position = resolve(options.targetMs());

    if (!position) {
      activeSegment.value = null;
      element.removeAttribute("src");
      element.load();
      message.value = "No recorded material at this timecode";
      return;
    }

    message.value = "";

    if (activeSegment.value?.fileName !== position.segment.fileName) {
      activeSegment.value = position.segment;
      // srcObject wins over src on a video element, so a leftover WebRTC stream would otherwise
      // keep playing over the top of the file we are about to load.
      element.srcObject = null;
      element.src = position.segment.url;
      seekWhenReady(element, position.offsetSeconds);
      element.play().catch(() => {});
      return;
    }

    // Same file, already playing it — only nudge when it has actually come adrift.
    if (Math.abs(element.currentTime - position.offsetSeconds) > RESYNC_THRESHOLD_SECONDS) {
      element.currentTime = position.offsetSeconds;
    }

    if (element.paused) element.play().catch(() => {});
  }

  async function start(next: StartOptions): Promise<void> {
    stop();
    options = next;
    isEngaged.value = true;

    await loadSegments(next.folder);
    resync();
    resyncHandle = window.setInterval(resync, RESYNC_INTERVAL_MS);
  }

  /** Picks up segments written since the last load — the folder may still be recording. */
  async function refreshSegments(): Promise<void> {
    if (!isEngaged.value || !options) return;
    await loadSegments(options.folder);
  }

  function stop(): void {
    if (resyncHandle !== null) {
      window.clearInterval(resyncHandle);
      resyncHandle = null;
    }

    const element = video.value;
    if (element && activeSegment.value) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }

    options = null;
    activeSegment.value = null;
    isEngaged.value = false;
    message.value = "";
  }

  return { segments, activeSegment, message, isEngaged, start, stop, refreshSegments };
}
