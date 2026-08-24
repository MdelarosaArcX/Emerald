/**
 * Talks directly to the main Emerald backend (the Deltacast capture/on-air server) for live
 * preview WHEP URLs — a completely separate server from LiveEdit's own backend (see api.ts),
 * reached over the LAN since LiveEdit runs on its own machine. Deliberately not routed through
 * api.ts's `request()` helper: that one expects the LiveEdit backend's {success,data,error}
 * envelope, the Emerald backend returns plain JSON.
 */

const EMERALD_API_BASE = (import.meta.env.VITE_EMERALD_API_BASE_URL || 'http://10.0.0.32:5000').replace(/\/+$/, '');

// Base URL of the main Emerald *frontend* (its chromeless /monitor confidence pages), as opposed
// to EMERALD_API_BASE which is the backend. The capture / on-air previews embed these pages
// directly instead of this app negotiating its own WHEP session — the monitor page owns the
// live playback and self-heals on its own.
const EMERALD_MONITOR_BASE = (import.meta.env.VITE_EMERALD_MONITOR_BASE_URL || 'http://10.0.0.32:5173').replace(/\/+$/, '');
export const captureMonitorUrl = `${EMERALD_MONITOR_BASE}/monitor/capture`;
export const onAirMonitorUrl = `${EMERALD_MONITOR_BASE}/monitor/onair`;

async function fetchWhepUrl(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}${path}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { whepUrl?: string };
    return body.whepUrl || null;
  } catch {
    return null;
  }
}

/** Capture page's own live preview (RX3-sourced). */
export function fetchCapturePreviewWhepUrl(): Promise<string | null> {
  return fetchWhepUrl('/api/webrtc-preview/status');
}

/** On-air preview — real physical SDI loopback of what's actually being transmitted (RX5-sourced). */
export function fetchOnAirPreviewWhepUrl(): Promise<string | null> {
  return fetchWhepUrl('/api/onair-preview/status');
}

/**
 * A recorded segment served by the Emerald backend for one recording session folder. kind is
 * "mp4" for a finished, playable clip, or "ts" for a raw HLS transport-stream segment from a
 * still-recording session — those exist purely for LiveEdit's own scrub/timeline playback of the
 * live tail and are never meant to be listed as a clip (see RecordedClipsBrowser.vue's
 * kind === 'mp4' filter).
 */
export interface RecordedClip {
  fileName: string;
  sessionFolder: string;
  kind: 'mp4' | 'ts';
  url: string; // absolute (playable in <video>)
  thumbnailUrl: string | null; // absolute; null for ts segments (no thumbnail is generated for those)
  size: number;
  createdAt: string;
  // ffprobed off the real file server-side — null for ts (never probed) or for an mp4 segment
  // still being actively written (ffmpeg hasn't finalized it yet).
  durationSeconds: number | null;
  // null for ts (not probed); for mp4, whether the source actually had an embedded audio track
  // (Emerald's audio map is optional, so a video-only source is a real, if uncommon, case).
  hasAudio: boolean | null;
  /**
   * The segment's real recorded timecode ("HH:MM:SS:FF"), on the Timecode System generator's
   * clock — null for segments predating per-segment timecodes, and for .ts.
   *
   * This, not `createdAt`, is what a segment should be positioned by. `createdAt` is the file's
   * birthtime as reported by whichever machine is asking, so placing clips with it drifts from the
   * generator by however far these machines' clocks differ — which is exactly why the timeline and
   * the playback/on-air clocks disagreed. Emerald derives this one by putting birthtime through
   * timecodeAtLocalInstant, so it is expressed on the same clock the on-air position and the
   * playback deck's readout already use.
   */
  startTimecode: string | null;
  /** Frame rate the session was recorded at, for converting startTimecode to frames. */
  frameRate: number | null;
}

/** One recording session — a folder of segments written by the Emerald recorder. */
export interface RecordingSession {
  folder: string;
  createdAt: string;
  segmentCount: number;
  size: number;
  isActive: boolean;
}

/** Every recording session Emerald has on disk, newest first — the Video Library's folder grid. */
export async function fetchRecordingSessions(): Promise<RecordingSession[]> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/recording-sessions`);
    if (!res.ok) return [];
    const sessions = (await res.json()) as RecordingSession[];
    return sessions.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch {
    return [];
  }
}

/**
 * The session Emerald is actively recording into, or the most recently created one when nothing is
 * recording. The live fallback matters for the timeline's live sync: the session that just stopped
 * is still the one that was last on air, so it stays loaded rather than the timeline emptying the
 * moment a recording ends.
 */
export async function fetchActiveOrLatestSession(): Promise<RecordingSession | null> {
  const sessions = await fetchRecordingSessions();
  return sessions.find((session) => session.isActive) ?? sessions[0] ?? null;
}

/** Just the folder name — the common case for callers that only need somewhere to list from. */
async function fetchActiveOrLatestSessionFolder(): Promise<string | null> {
  return (await fetchActiveOrLatestSession())?.folder ?? null;
}

/**
 * Lists every segment — finished .mp4 clips and, for a still-recording session, the .ts HLS
 * segments too — for one session folder, rewriting the backend-relative url/thumbnailUrl into
 * absolute URLs so they load cross-origin from this app.
 */
export async function fetchSessionClips(folder: string): Promise<RecordedClip[]> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/recording-sessions/${encodeURIComponent(folder)}/segments`);
    if (!res.ok) return [];
    const list = (await res.json()) as Array<Omit<RecordedClip, 'sessionFolder'>>;

    return list.map((segment) => ({
      ...segment,
      sessionFolder: folder,
      url: `${EMERALD_API_BASE}${segment.url}`,
      thumbnailUrl: segment.thumbnailUrl ? `${EMERALD_API_BASE}${segment.thumbnailUrl}` : null,
    }));
  } catch {
    return [];
  }
}

/** Segments of the active (or most recent) session — used where no folder has been chosen. */
export async function fetchRecordedClips(): Promise<RecordedClip[]> {
  const folder = await fetchActiveOrLatestSessionFolder();
  return folder ? fetchSessionClips(folder) : [];
}

export interface EmeraldTimecode {
  /** Live wall-clock timecode from Emerald's master generator, HH:MM:SS:FF local time of day. */
  timecode: string;
  /**
   * The Emerald backend's own "now" for this response. Paired with onAir.startedAt to measure how
   * long TX has been up as a duration on a single machine's clock — LiveEdit's own clock is never
   * involved, so a workstation whose time is a few seconds off doesn't skew where on air began.
   */
  timestamp: string;
  /** The generator's frame rate. Read rather than assumed — see useTimecode on why that matters. */
  fps: number;
  capture: { isCapturing: boolean };
  onAir: {
    isTransmitting: boolean;
    /** ISO instant TX went live; null when off air. */
    startedAt: string | null;
    /**
     * Timecode of the material actually going out right now. Not the same as `timecode` above: a
     * broadcast-delayed live feed is transmitting footage captured broadcastDelaySeconds ago, so
     * this is offset backward by that much (see the /api/capture/timecode comment in Emerald's
     * server.js). This is the one to line a timeline up against.
     */
    timecode: string;
    broadcastDelaySeconds: number;
  };
}

export async function fetchEmeraldTimecode(): Promise<EmeraldTimecode | null> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/capture/timecode`);
    if (!res.ok) return null;
    return (await res.json()) as EmeraldTimecode;
  } catch {
    return null;
  }
}

// --- Air EDL ---------------------------------------------------------------------------------
// Cutting material out of the transmission before it goes out. The window this operates in is the
// broadcast delay Emerald already holds segments back by; see the Emerald backend's
// services/airEdlService.js for the ripple model and the safety rules it enforces.

/** One committed cut — a wall-clock range that has been removed from the TX playlist. */
export interface AirCut {
  id: string;
  startMs: number;
  endMs: number;
  createdAt: string;
}

export interface AirEdlState {
  /** False when nothing is recording, i.e. there is no pre-air window to edit in at all. */
  active: boolean;
  cuts: AirCut[];
  /** Seconds of delay already spent on cuts. */
  spentSeconds: number;
  /** Seconds of editing runway left. Every cut debits this — cutting spends delay. */
  remainingDelaySeconds: number;
  /** Floor below which a further cut is refused, to keep TX from running out of playlist. */
  minRemainingDelaySeconds?: number;
  /** How far ahead of the air point a cut must start. */
  minLeadSeconds?: number;
  broadcastDelaySeconds?: number;
  recordingStartedAtMs?: number;
  sessionFolder?: string;
}

const IDLE_AIR_EDL: AirEdlState = { active: false, cuts: [], spentSeconds: 0, remainingDelaySeconds: 0 };

export async function fetchAirEdl(): Promise<AirEdlState> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/air-edl`);
    if (!res.ok) return IDLE_AIR_EDL;
    return (await res.json()) as AirEdlState;
  } catch {
    // Unreachable reads the same as "no editable window": the editor must not offer a cut it
    // cannot deliver.
    return IDLE_AIR_EDL;
  }
}

/**
 * Commits a cut. Resolves with the reason on refusal rather than throwing, because every refusal
 * here is a broadcast state the operator needs to read (already on air, not enough delay left),
 * not an exception.
 */
export async function cutFromAir(startMs: number, endMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/air-edl/cut`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startMs, endMs }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false, error: body.message ?? `Emerald refused the cut (${res.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach Emerald to commit the cut.' };
  }
}

/** Puts a cut back, if the play point has not reached it yet. */
export async function restoreAirCut(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/air-edl/cut/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false, error: body.message ?? `Emerald refused to restore the cut (${res.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach Emerald to restore the cut.' };
  }
}
