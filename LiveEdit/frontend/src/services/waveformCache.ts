/**
 * Peak envelopes for timeline audio clips, fetched once per source and shared by every clip that
 * points at it.
 *
 * The peaks are produced server-side by GET /api/waveform (see render.controller.ts), which runs
 * ffmpeg against the source and returns a small array of amplitude buckets. That is deliberately
 * preferred over decoding in the browser: reading a recorded segment here would mean downloading
 * the entire file — a two-minute 1080p segment measures ~126MB — and decoding it into an
 * AudioBuffer several times larger again, purely to derive a few thousand numbers. The server
 * reads the same file locally, downsamples to 8kHz mono, and returns tens of KB.
 *
 * Caching matters even so: one dropped segment already creates two clips (the video and its
 * paired audio lane), and splitting at the playhead multiplies them further, all sharing one
 * source. This keeps that to a single request.
 */

/** Peak envelope for one decoded source. */
export interface SourcePeaks {
  /** Amplitude per bucket (0..1), covering the entire source. */
  peaks: number[];
  /** How many seconds those buckets span — the basis for mapping a clip's trim to indices. */
  duration: number;
}

const cache = new Map<string, Promise<SourcePeaks>>();

/**
 * How long a failed source is left alone before another request is allowed.
 *
 * Failures here are not cheap for the other end: each request runs an ffmpeg that reads the whole
 * segment from the Emerald backend, and the usual reason one fails is that that backend is busy
 * (a ProRes recording saturates the machine and static file serving slows to a crawl). Evicting
 * on failure and letting the next render try again turns exactly that situation into a pile-up of
 * concurrent extractions, each making the others slower. Remembering the failure for a while
 * means a clip that can't get its waveform right now simply shows its flat line and tries again
 * later, instead of adding load to a system already struggling.
 */
const FAILURE_COOLDOWN_MS = 60_000;
const failedAt = new Map<string, number>();

async function fetchPeaks(url: string): Promise<SourcePeaks> {
  const response = await fetch(`/api/waveform?url=${encodeURIComponent(url)}`);
  if (!response.ok) throw new Error(`waveform request failed: ${response.status}`);

  const body = (await response.json()) as { data?: { peaks?: number[]; durationSeconds?: number } };
  const peaks = body.data?.peaks;
  const duration = body.data?.durationSeconds;

  // An empty array is the endpoint's way of saying the source has no audio track. Treated as a
  // failure here so the clip shows its "no readable audio" line rather than an empty waveform
  // that looks like silence — the two mean different things to an editor.
  if (!Array.isArray(peaks) || !peaks.length || !duration) {
    throw new Error('source has no readable audio');
  }

  return { peaks, duration };
}

/**
 * Peaks for a source URL, requesting on first call and sharing the same promise with every later
 * caller. A failure is remembered for FAILURE_COOLDOWN_MS before another attempt is allowed, so a
 * source that cannot be read right now degrades to a flat line rather than being retried by every
 * clip that references it.
 */
export function getSourcePeaks(url: string): Promise<SourcePeaks> {
  const existing = cache.get(url);
  if (existing) return existing;

  const lastFailure = failedAt.get(url);
  if (lastFailure !== undefined && Date.now() - lastFailure < FAILURE_COOLDOWN_MS) {
    return Promise.reject(new Error('waveform unavailable (cooling down after a recent failure)'));
  }

  const pending = fetchPeaks(url).catch((error) => {
    cache.delete(url);
    failedAt.set(url, Date.now());
    throw error;
  });

  cache.set(url, pending);
  return pending;
}

/**
 * The slice of a source's peaks covering one clip's trimmed region, resampled to `buckets` so the
 * caller gets a fixed-length array regardless of how much of the source the clip covers.
 *
 * Clamped rather than validated: a clip whose trim runs past the decoded duration (a source that
 * turned out shorter than its frame count suggested) renders the part that does exist instead of
 * throwing and leaving the clip blank.
 */
export function slicePeaks(
  source: SourcePeaks,
  fromSeconds: number,
  toSeconds: number,
  buckets: number,
): number[] {
  const total = source.peaks.length;
  const duration = source.duration || 1;

  const startIndex = Math.max(0, Math.min(total - 1, Math.floor((fromSeconds / duration) * total)));
  const endIndex = Math.max(startIndex + 1, Math.min(total, Math.ceil((toSeconds / duration) * total)));
  const span = endIndex - startIndex;

  const out: number[] = new Array(buckets);
  for (let i = 0; i < buckets; i += 1) {
    const from = startIndex + Math.floor((i / buckets) * span);
    const to = Math.max(from + 1, startIndex + Math.floor(((i + 1) / buckets) * span));
    let max = 0;
    for (let j = from; j < to && j < total; j += 1) {
      if (source.peaks[j] > max) max = source.peaks[j];
    }
    out[i] = max;
  }

  return out;
}
