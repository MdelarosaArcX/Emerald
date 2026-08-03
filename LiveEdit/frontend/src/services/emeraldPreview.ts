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

/** A recorded H.264 clip segment served by the Emerald backend. */
export interface RecordedClip {
  fileName: string;
  sessionFolder: string;
  url: string; // absolute (playable in <video>)
  thumbnailUrl: string; // absolute
  size: number;
  createdAt: string;
}

/**
 * Lists recorded clips from the Emerald backend (the /api/obs-recordings endpoint on 10.0.0.32),
 * rewriting the backend-relative url/thumbnailUrl into absolute URLs so they load cross-origin
 * from this app. Note: the backend stats a large recordings volume, so this call can take a while.
 */
export async function fetchRecordedClips(): Promise<RecordedClip[]> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/obs-recordings`);
    if (!res.ok) return [];
    const list = (await res.json()) as RecordedClip[];
    return list.map((clip) => ({
      ...clip,
      url: `${EMERALD_API_BASE}${clip.url}`,
      thumbnailUrl: `${EMERALD_API_BASE}${clip.thumbnailUrl}`,
    }));
  } catch {
    return [];
  }
}

/** A recording session (one folder of segments written by the Emerald recorder). */
export interface RecordingSession {
  folder: string;
  createdAt: string;
  segmentCount: number;
  size: number;
  isActive: boolean;
}

/** One segment within a session. */
export interface RecordedSegment {
  fileName: string;
  index: number; // derived from the emerald-NNN.mp4 filename (the API does not send it)
  url: string; // absolute
  thumbnailUrl: string; // absolute
  size: number;
  createdAt: string;
  durationSeconds?: number | null; // real segment length reported by the backend, when known
}

/** List recording sessions (folders), newest first. */
export async function fetchRecordingSessions(): Promise<RecordingSession[]> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/recording-sessions`);
    if (!res.ok) return [];
    const list = (await res.json()) as RecordingSession[];
    return list.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } catch {
    return [];
  }
}

/** Only browser-relevant video/audio files are ever loaded onto the timeline. */
const MEDIA_FILE_RE = /\.(mp4|mov|m4v|webm|mkv|wav|aac|mp3|m4a|flac|ogg)$/i;

/** Trailing numeric index of a segment file, e.g. `emerald-007.mp4` → 7. */
const SEGMENT_INDEX_RE = /-(\d+)\.[A-Za-z0-9]+$/;

/**
 * List a session's video/audio segments in recording order, with absolute URLs.
 * The Emerald backend does NOT send a numeric `index`, so we derive it from the `emerald-NNN.mp4`
 * filename — this is what positions each clip in its own sequential timeline slot. Falling back to
 * an undefined index would place every clip at frame NaN (all stacked at once).
 */
export async function fetchSessionSegments(folder: string): Promise<RecordedSegment[]> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/recording-sessions/${encodeURIComponent(folder)}/segments`);
    if (!res.ok) return [];
    const list = (await res.json()) as Array<Partial<RecordedSegment> & { fileName: string; url: string; thumbnailUrl?: string | null }>;
    return list
      .filter((s) => MEDIA_FILE_RE.test(s.fileName))
      .map((s, i) => {
        const m = SEGMENT_INDEX_RE.exec(s.fileName);
        const index = m ? Number(m[1]) : Number.isFinite(s.index) ? (s.index as number) : i;
        return {
          fileName: s.fileName,
          index,
          size: s.size ?? 0,
          createdAt: s.createdAt ?? '',
          durationSeconds: s.durationSeconds ?? null,
          url: `${EMERALD_API_BASE}${s.url}`,
          thumbnailUrl: s.thumbnailUrl ? `${EMERALD_API_BASE}${s.thumbnailUrl}` : '',
        } satisfies RecordedSegment;
      })
      .sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

/** Current recorder status: whether it's recording, the active session folder, and segment length. */
export async function fetchActiveRecording(): Promise<{ isRecording: boolean; folder: string | null; segmentSeconds: number }> {
  try {
    const res = await fetch(`${EMERALD_API_BASE}/api/obs-recording/status`);
    if (!res.ok) return { isRecording: false, folder: null, segmentSeconds: 120 };
    const s = (await res.json()) as { isRecording?: boolean; outputPattern?: string | null; segmentSeconds?: number };
    let folder: string | null = null;
    if (s.outputPattern) {
      const m = /[\\/]([^\\/]+)[\\/][^\\/]+$/.exec(s.outputPattern); // folder just before the filename pattern
      folder = m ? m[1] : null;
    }
    return { isRecording: Boolean(s.isRecording), folder, segmentSeconds: s.segmentSeconds || 120 };
  } catch {
    return { isRecording: false, folder: null, segmentSeconds: 120 };
  }
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
