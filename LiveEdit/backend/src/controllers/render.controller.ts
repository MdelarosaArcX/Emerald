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
