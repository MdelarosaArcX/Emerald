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
 * Resolves which recording session folder to fall back to when no folder has been picked:
 * whichever session Emerald is actively recording into, or the most recently created one.
 */
async function fetchActiveOrLatestSessionFolder(): Promise<string | null> {
  const sessions = await fetchRecordingSessions();
  return sessions.find((session) => session.isActive)?.folder ?? sessions[0]?.folder ?? null;
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
  timecode: string;
  capture: { isCapturing: boolean };
  onAir: { isTransmitting: boolean; timecode: string; broadcastDelaySeconds: number };
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
