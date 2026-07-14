/**
 * Talks directly to the main Emerald backend (the Deltacast capture/on-air server) for live
 * preview WHEP URLs — a completely separate server from LiveEdit's own backend (see api.ts),
 * reached over the LAN since LiveEdit runs on its own machine. Deliberately not routed through
 * api.ts's `request()` helper: that one expects the LiveEdit backend's {success,data,error}
 * envelope, the Emerald backend returns plain JSON.
 */

const EMERALD_API_BASE = (import.meta.env.VITE_EMERALD_API_BASE_URL || 'http://10.0.0.32:5000').replace(/\/+$/, '');

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
