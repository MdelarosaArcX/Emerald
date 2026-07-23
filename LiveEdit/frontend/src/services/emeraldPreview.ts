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
