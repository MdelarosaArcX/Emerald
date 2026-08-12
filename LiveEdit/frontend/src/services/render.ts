/**
 * Talks to the LiveEdit backend's media pipeline: proxy generation (browser-playable, lightweight
 * versions of the non-faststart recorded segments) and sequence rendering (trim + concat).
 * Routed through Vite's /api, /proxies, /renders proxies to the backend on :4000.
 */

/** Ask the backend for a browser-playable proxy of a recorded segment. Returns a relative URL. */
export async function requestProxy(sourceUrl: string): Promise<string | null> {
  try {
    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: sourceUrl }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { url?: string } };
    return body.data?.url ?? null;
  } catch {
    return null;
  }
}

const waveformCache = new Map<string, Promise<number[] | null>>();

// Cap concurrent waveform extractions — each spawns an ffmpeg that reads the (slow, remote) source,
// so a bulk load of many audio clips shouldn't fire them all at once.
const MAX_CONCURRENT_WAVEFORMS = 3;
let activeWaveforms = 0;
const waveformQueue: Array<() => void> = [];
function acquireWaveformSlot(): Promise<void> {
  if (activeWaveforms < MAX_CONCURRENT_WAVEFORMS) {
    activeWaveforms += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waveformQueue.push(resolve));
}
function releaseWaveformSlot(): void {
  const next = waveformQueue.shift();
  if (next) next();
  else activeWaveforms -= 1;
}

/**
 * Fetch the audio waveform (peak amplitude buckets, 0..1) of a source so an audio clip can draw its
 * real shape on the timeline. Deduped/cached per URL; returns null if the source has no audio or
 * couldn't be read (the caller keeps its placeholder waveform in that case).
 */
export function fetchWaveform(sourceUrl: string): Promise<number[] | null> {
  if (!/^https?:/i.test(sourceUrl)) return Promise.resolve(null);
  const cached = waveformCache.get(sourceUrl);
  if (cached) return cached;
  const request = (async () => {
    await acquireWaveformSlot();
    try {
      const res = await fetch(`/api/waveform?url=${encodeURIComponent(sourceUrl)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { peaks?: number[] } };
      const peaks = body.data?.peaks;
      return Array.isArray(peaks) && peaks.length ? peaks : null;
    } catch {
      return null;
    } finally {
      releaseWaveformSlot();
    }
  })();
  waveformCache.set(sourceUrl, request);
  return request;
}

export interface RenderClipInput {
  url: string;
  trimInFrames: number;
  trimOutFrames: number;
}

/** Render the given (trimmed, ordered) clips into one MP4. Returns a relative output URL. */
export async function renderSequence(clips: RenderClipInput[], fps: number): Promise<string | null> {
  const res = await fetch('/api/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clips, fps }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { url?: string }; error?: string };
  if (!res.ok) throw new Error(body.error || 'Render failed');
  return body.data?.url ?? null;
}
