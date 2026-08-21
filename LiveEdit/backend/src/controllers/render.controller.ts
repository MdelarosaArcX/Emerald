import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import { logger } from '../utils/logger';
import { LOCAL_EXPORTS_AVAILABLE, LOCAL_EXPORTS_PATH, LOCAL_RECORDINGS_AVAILABLE, LOCAL_RECORDINGS_PATH } from '../utils/localRecordings';
import { IMPORT_DIR } from '../utils/mediaPaths';

/**
 * Media pipeline: generates lightweight, browser-playable proxies of the (non-faststart, large)
 * recorded segments, and renders a timeline sequence into a single output. FFmpeg reads the source
 * segments directly from the Emerald backend over HTTP, so this works without local file access.
 */

// Exported so media.controller extracts poster frames with the same binary this resolves, rather
// than duplicating the static-package lookup and risking the two disagreeing.
export const FFMPEG_FOR_THUMBS = (ffmpegStatic as unknown as string) || 'ffmpeg';
const FFMPEG = FFMPEG_FOR_THUMBS;

const CACHE_ROOT = path.resolve(process.cwd(), '.media-cache');
export const PROXY_DIR = path.join(CACHE_ROOT, 'proxies');
export const RENDER_DIR = path.join(CACHE_ROOT, 'renders');
fs.mkdirSync(PROXY_DIR, { recursive: true });
fs.mkdirSync(RENDER_DIR, { recursive: true });

function keyFor(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-600) || `ffmpeg exited ${code}`))));
  });
}

// --- Audio waveform ---------------------------------------------------------------------------
/**
 * Peak buckets returned for a whole source. Raised from 240 because a clip draws the slice of
 * these covering its own trim, not the whole array: at 240 a two-minute segment gave one bucket
 * per half-second, so a clip trimmed to a few seconds had barely a dozen buckets to draw and came
 * out as blocks rather than a waveform — the exact failure this endpoint exists to prevent.
 *
 * Costs almost nothing to raise: the ffmpeg decode below dominates and happens either way, this
 * only changes how finely the resulting PCM is reduced. At 8kHz mono a two-minute source is
 * ~960k samples, so 2000 buckets still averages ~480 samples each, and the JSON stays tens of KB.
 */
const WAVEFORM_BUCKETS = 2000;
/**
 * Rate the audio is decoded to for analysis. Named rather than repeated as a literal because the
 * duration reported below is derived from the sample count at this exact rate — if the ffmpeg
 * argument and this constant ever disagreed, every clip's waveform would silently be windowed to
 * the wrong part of its source.
 */
const AUDIO_ANALYSIS_RATE_HZ = 8000;
/**
 * Peaks plus the source's real decoded duration. The duration is what lets a clip map its trim
 * points (which are frames into the source) onto indices in the peak array — without it a trimmed
 * clip can only guess which part of the waveform is its own.
 */
interface SourceWaveform {
  peaks: number[];
  durationSeconds: number;
}

const waveformCache = new Map<string, SourceWaveform>();
const waveformInFlight = new Map<string, Promise<SourceWaveform>>();

/**
 * Ceiling on one extraction. Without it a source that reads slowly has no way to end: measured
 * against the Emerald backend while it was busy writing a ProRes recording, the same segment that
 * decodes in 0.7s from local disk was still only 4% read after a minute over HTTP, and each
 * stalled attempt kept its ffmpeg alive competing with the next. Failing lets the clip fall back
 * to its flat line and try again later, which is the better outcome.
 */
const WAVEFORM_TIMEOUT_MS = 45_000;

/**
 * Rewrites an Emerald recordings URL to a path on this disk when Emerald's Recordings folder is
 * local (EMERALD_RECORDINGS_PATH — same machine deployment, which is how this box runs).
 *
 * Worth the trouble because the alternative is pulling the whole segment back over HTTP from a
 * backend that is frequently busy recording: ~126MB for two minutes of 1080p, to derive a few
 * thousand numbers. Reading the identical file off disk took 0.7s against minutes over HTTP under
 * load. Returns the original URL unchanged when there is no local copy, so the remote deployment
 * keeps working exactly as before.
 */
function resolveReadableSource(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return url;
  }

  // Each mount maps a URL prefix onto the local folder Emerald serves it from.
  const roots: Array<{ pattern: RegExp; root: string | null; available: boolean }> = [
    { pattern: /^\/(?:recordings|local-recordings)\/(.+)$/, root: LOCAL_RECORDINGS_PATH, available: LOCAL_RECORDINGS_AVAILABLE },
    { pattern: /^\/exports\/(.+)$/, root: LOCAL_EXPORTS_PATH, available: LOCAL_EXPORTS_AVAILABLE },
    // Imported media is always local — this process wrote it — so unlike the two mounts above
    // there is no availability flag to check. Without this entry, proxying or reading a waveform
    // from an import would fetch it back over HTTP from whichever origin is serving the frontend,
    // which in the split deployment the backend may not be able to reach at all.
    { pattern: /^\/media-imports\/(.+)$/, root: IMPORT_DIR, available: true },
  ];

  const mount = roots.find((candidate) => candidate.available && candidate.root && candidate.pattern.test(pathname));
  if (!mount || !mount.root) return url;

  const match = mount.pattern.exec(pathname);
  if (!match) return url;

  const relative = decodeURIComponent(match[1]);
  // Refuse anything that climbs out of the mounted root — the url is attacker-controllable in
  // principle, and this turns it into a filesystem read.
  const root = path.resolve(mount.root);
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(root + path.sep)) return url;

  return fs.existsSync(candidate) ? candidate : url;
}

/**
 * Decode a source's audio to low-rate mono PCM and reduce it to `WAVEFORM_BUCKETS` peak amplitudes
 * (0..1) for drawing the clip's waveform on the timeline. Reading the audio server-side sidesteps
 * the browser's cross-origin restriction on analysing recorded segments via the Web Audio API.
 */
function extractPeaks(url: string): Promise<SourceWaveform> {
  const key = keyFor(url);
  const cached = waveformCache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = waveformInFlight.get(key);
  if (existing) return existing;

  const job = new Promise<SourceWaveform>((resolve, reject) => {
    const source = resolveReadableSource(url);
    const args = ['-hide_banner', '-loglevel', 'error', '-i', source, '-vn', '-ac', '1', '-ar', String(AUDIO_ANALYSIS_RATE_HZ), '-f', 's16le', 'pipe:1'];
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn(`waveform extraction timed out after ${WAVEFORM_TIMEOUT_MS}ms: ${source}`);
      try { proc.kill(); } catch { /* already gone */ }
    }, WAVEFORM_TIMEOUT_MS);

    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // Whatever was decoded before the kill covers only the start of the source, so drawing it
        // would mislabel the clip's shape. Better to have no waveform than a wrong one.
        reject(new Error('waveform extraction timed out'));
        return;
      }
      const buf = Buffer.concat(chunks);
      const sampleCount = Math.floor(buf.length / 2);
      if (sampleCount === 0) {
        if (code !== 0) reject(new Error(err.slice(-400) || `ffmpeg exited ${code}`));
        else resolve({ peaks: [], durationSeconds: 0 }); // source has no audio track
        return;
      }
      // Derived from the sample count rather than probed separately: this is decoded mono PCM at a
      // known rate, so it already describes exactly how much audio the peaks cover.
      const durationSeconds = sampleCount / AUDIO_ANALYSIS_RATE_HZ;
      const per = Math.max(1, Math.floor(sampleCount / WAVEFORM_BUCKETS));
      const peaks: number[] = [];
      for (let b = 0; b < WAVEFORM_BUCKETS; b += 1) {
        let max = 0;
        for (let i = 0; i < per; i += 1) {
          const idx = (b * per + i) * 2;
          if (idx + 1 >= buf.length) break;
          const v = Math.abs(buf.readInt16LE(idx)) / 32768;
          if (v > max) max = v;
        }
        peaks.push(max);
      }
      const top = Math.max(0.0001, ...peaks);
      resolve({
        peaks: peaks.map((p) => 0.08 + (p / top) * 0.92), // normalise, keep a visible floor
        durationSeconds,
      });
    });
  })
    .then((result) => {
      if (result.peaks.length) waveformCache.set(key, result);
      return result;
    })
    .finally(() => waveformInFlight.delete(key));

  waveformInFlight.set(key, job);
  return job;
}

/**
 * GET /api/waveform?url=...  → { peaks: number[], durationSeconds: number } amplitude buckets
 * (0..1) spanning the whole source, plus how many seconds they cover so a trimmed clip can index
 * into them.
 */
export async function requestWaveform(req: Request, res: Response): Promise<void> {
  const url = String((req.query.url ?? req.body?.url) || '');
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ success: false, error: 'A source url is required' });
    return;
  }
  try {
    const { peaks, durationSeconds } = await extractPeaks(url);
    res.json({ success: true, data: { peaks, durationSeconds } });
  } catch (e) {
    logger.error('waveform extraction failed', e as Error);
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'waveform failed' });
  }
}

// --- Source timecode ---------------------------------------------------------------------------

// Exported so media.controller probes imports with the same binary this resolves, rather than
// duplicating the static-package lookup and risking the two disagreeing.
export const FFPROBE = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const probe = require('ffprobe-static');
    return (probe?.path as string) || 'ffprobe';
  } catch {
    return 'ffprobe';
  }
})();

const timecodeCache = new Map<string, string | null>();

/**
 * GET /api/source-timecode?url=...  → { timecode: "HH:MM:SS:FF" | null }
 *
 * Reads a file's embedded QuickTime `tmcd` track. Emerald's clip export writes one (see
 * clipExportService.js), which is what lets an exported file land on the timeline at the
 * timecode it was captured at rather than wherever it happened to be dropped.
 *
 * Null — not an error — when the file has no timecode track. Plenty of sources legitimately
 * don't, and the caller falls back to the drop position for those.
 */
export async function requestSourceTimecode(req: Request, res: Response): Promise<void> {
  const url = String(req.query.url ?? '');
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ success: false, error: 'A source url is required' });
    return;
  }

  const key = keyFor(url);
  if (timecodeCache.has(key)) {
    res.json({ success: true, data: { timecode: timecodeCache.get(key) ?? null } });
    return;
  }

  const source = resolveReadableSource(url);

  try {
    const timecode = await new Promise<string | null>((resolve, reject) => {
      const args = [
        '-v', 'error',
        // The tmcd track surfaces as a stream tag; some muxers also put it on the container, so
        // both are asked for and whichever is present wins.
        '-show_entries', 'format_tags=timecode:stream_tags=timecode',
        '-of', 'json',
        source,
      ];
      const proc = spawn(FFPROBE, args, { windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 20_000);

      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.stderr.on('data', (d) => (err += d.toString()));
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(err.slice(-300) || `ffprobe exited ${code}`));

        try {
          const parsed = JSON.parse(out || '{}');
          const fromStream = (parsed.streams || [])
            .map((s: { tags?: { timecode?: string } }) => s?.tags?.timecode)
            .find((tc: string | undefined) => typeof tc === 'string' && /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(tc));
          const fromFormat = parsed.format?.tags?.timecode;
          resolve(fromStream || (typeof fromFormat === 'string' ? fromFormat : null));
        } catch {
          resolve(null);
        }
      });
    });

    timecodeCache.set(key, timecode);
    res.json({ success: true, data: { timecode } });
  } catch (e) {
    logger.warn(`source timecode read failed for ${source}: ${e instanceof Error ? e.message : String(e)}`);
    // Not a 500: an unreadable timecode is a normal outcome for many sources, and the caller
    // simply falls back to the drop position.
    res.json({ success: true, data: { timecode: null } });
  }
}

const proxyInFlight = new Map<string, Promise<string>>();

/** Generate (or reuse) a 480p faststart H.264 proxy for a source segment URL. Returns the cache filename. */
function ensureProxy(url: string): Promise<string> {
  const key = keyFor(url);
  const fileName = `${key}.mp4`;
  const out = path.join(PROXY_DIR, fileName);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return Promise.resolve(fileName);
  const existing = proxyInFlight.get(key);
  if (existing) return existing;

  const tmp = `${out}.tmp.mp4`;
  const job = runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', url,
    '-vf', 'scale=-2:480',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    tmp,
  ])
    .then(() => {
      fs.renameSync(tmp, out);
      return fileName;
    })
    .catch((e) => {
      fs.rmSync(tmp, { force: true });
      throw e;
    })
    .finally(() => proxyInFlight.delete(key));

  proxyInFlight.set(key, job);
  return job;
}

/**
 * POST /api/proxy  { url }
 * Returns a browser-playable proxy URL for a recorded segment. First call transcodes (slow); the
 * result is cached so subsequent calls are instant.
 */
export async function requestProxy(req: Request, res: Response): Promise<void> {
  const url = String((req.body?.url ?? req.query.url) || '');
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ success: false, error: 'A source url is required' });
    return;
  }
  try {
    const fileName = await ensureProxy(url);
    res.json({ success: true, data: { url: `/proxies/${fileName}` } });
  } catch (e) {
    logger.error('proxy generation failed', e as Error);
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'proxy generation failed' });
  }
}

interface RenderClip {
  url: string;
  trimInFrames?: number;
  trimOutFrames?: number;
}

/**
 * POST /api/render  { clips: [{ url, trimInFrames, trimOutFrames }], fps }
 * Trims each clip and concatenates them into one faststart MP4. Returns the output URL.
 */
export async function requestRender(req: Request, res: Response): Promise<void> {
  const body = req.body as { clips?: RenderClip[]; fps?: number };
  const clips = (body.clips || []).filter((c) => /^https?:\/\//i.test(c.url));
  const fps = Math.max(1, body.fps || 25);
  if (!clips.length) {
    res.status(400).json({ success: false, error: 'No clips to render' });
    return;
  }

  const key = keyFor(JSON.stringify(clips) + `@${fps}`);
  const outName = `${key}.mp4`;
  const out = path.join(RENDER_DIR, outName);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) {
    res.json({ success: true, data: { url: `/renders/${outName}` } });
    return;
  }

  const parts: string[] = [];
  try {
    for (let i = 0; i < clips.length; i += 1) {
      const c = clips[i];
      const inSec = Math.max(0, (c.trimInFrames ?? 0) / fps);
      const spanFrames = (c.trimOutFrames ?? 0) - (c.trimInFrames ?? 0);
      const durSec = spanFrames > 0 ? spanFrames / fps : 5;
      const part = path.join(RENDER_DIR, `${key}-part${i}.mp4`);
      // Normalise every part to the same format so they concat cleanly.
      await runFfmpeg([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-ss', String(inSec), '-t', String(durSec), '-i', c.url,
        '-vf', `scale=1280:-2,fps=${fps}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', part,
      ]);
      parts.push(part);
    }

    const listFile = path.join(RENDER_DIR, `${key}-list.txt`);
    fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
    await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', out]);

    parts.forEach((p) => fs.rmSync(p, { force: true }));
    fs.rmSync(listFile, { force: true });
    res.json({ success: true, data: { url: `/renders/${outName}` } });
  } catch (e) {
    parts.forEach((p) => fs.rmSync(p, { force: true }));
    logger.error('render failed', e as Error);
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'render failed' });
  }
}
