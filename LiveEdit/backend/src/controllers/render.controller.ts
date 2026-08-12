import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import { logger } from '../utils/logger';

/**
 * Media pipeline: generates lightweight, browser-playable proxies of the (non-faststart, large)
 * recorded segments, and renders a timeline sequence into a single output. FFmpeg reads the source
 * segments directly from the Emerald backend over HTTP, so this works without local file access.
 */

const FFMPEG = (ffmpegStatic as unknown as string) || 'ffmpeg';

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
const WAVEFORM_BUCKETS = 240;
const waveformCache = new Map<string, number[]>();
const waveformInFlight = new Map<string, Promise<number[]>>();

/**
 * Decode a source's audio to low-rate mono PCM and reduce it to `WAVEFORM_BUCKETS` peak amplitudes
 * (0..1) for drawing the clip's waveform on the timeline. Reading the audio server-side sidesteps
 * the browser's cross-origin restriction on analysing recorded segments via the Web Audio API.
 */
function extractPeaks(url: string): Promise<number[]> {
  const key = keyFor(url);
  const cached = waveformCache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = waveformInFlight.get(key);
  if (existing) return existing;

  const job = new Promise<number[]>((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', url, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'];
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      const buf = Buffer.concat(chunks);
      const sampleCount = Math.floor(buf.length / 2);
      if (sampleCount === 0) {
        if (code !== 0) reject(new Error(err.slice(-400) || `ffmpeg exited ${code}`));
        else resolve([]); // source has no audio track
        return;
      }
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
      resolve(peaks.map((p) => 0.08 + (p / top) * 0.92)); // normalise, keep a visible floor
    });
  })
    .then((peaks) => {
      if (peaks.length) waveformCache.set(key, peaks);
      return peaks;
    })
    .finally(() => waveformInFlight.delete(key));

  waveformInFlight.set(key, job);
  return job;
}

/**
 * GET /api/waveform?url=...  → { peaks: number[] } amplitude buckets (0..1) for an audio clip.
 */
export async function requestWaveform(req: Request, res: Response): Promise<void> {
  const url = String((req.query.url ?? req.body?.url) || '');
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ success: false, error: 'A source url is required' });
    return;
  }
  try {
    const peaks = await extractPeaks(url);
    res.json({ success: true, data: { peaks } });
  } catch (e) {
    logger.error('waveform extraction failed', e as Error);
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'waveform failed' });
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
