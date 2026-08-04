/**
 * Talks to the LiveEdit backend's media pipeline: proxy generation (browser-playable, lightweight
 * versions of the non-faststart recorded segments) and sequence rendering (trim + concat).
 * Routed through Vite's /api, /proxies, /renders proxies to the backend on :5001.
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
