import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { MediaAsset } from '../types/project';
import { logger } from '../utils/logger';
import { IMPORT_DIR } from '../utils/mediaPaths';
import { FFMPEG_FOR_THUMBS, FFPROBE } from './render.controller';

/**
 * Importing outside media (music beds, stings, graphics, footage shot elsewhere) into the project
 * so it can be dragged onto the timeline alongside the recorded segments.
 *
 * Files are copied into the app's own media directory rather than referenced where they sit. A
 * reference would be cheaper, but the browser cannot play an arbitrary local path — the timeline
 * needs a URL it can hand to a <video> element — and a source that lives outside the app can be
 * moved or deleted underneath a project that still points at it. Copying costs disk and one write
 * per import, and in exchange every imported asset stays playable for as long as the project does.
 */

// Shared with render.controller (URL -> local file) and app.ts (static mount) — see mediaPaths.
export { IMPORT_DIR };

/** URL prefix the imports directory is served from — see app.ts and the frontend's vite proxy. */
const IMPORT_URL_PREFIX = '/media-imports';

/**
 * The asset list lives in a file next to the media rather than in memory, so imports survive the
 * nodemon restarts that happen constantly in development — losing the library on every backend
 * reload would make the feature untestable.
 */
const INDEX_FILE = path.join(IMPORT_DIR, 'index.json');

/**
 * Extensions accepted for import. An allow-list rather than a block-list: this directory is served
 * statically, so anything landing in it is publicly readable, and the set of things worth putting
 * on a timeline is small and known.
 */
const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.m4v', '.avi', '.mxf', '.webm', '.ts', '.mpg', '.mpeg',
  '.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.aiff', '.aif',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Codecs ffprobe reports as a video stream that are really a single still. */
const STILL_IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp', 'gif', 'bmp']);

interface ProbeResult {
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrateBps: number;
}

function readIndex(): MediaAsset[] {
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MediaAsset[]) : [];
  } catch {
    // Missing or corrupt index is the same situation as an empty library — the media files
    // themselves are still on disk, and a failed read must not take the whole project load down.
    return [];
  }
}

function writeIndex(assets: MediaAsset[]): void {
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(assets, null, 2), 'utf8');
  } catch (error) {
    logger.warn(`Could not persist the media import index: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Imported assets, for merging into the project descriptor. */
export function listImportedAssets(): MediaAsset[] {
  return readIndex();
}

/**
 * Strips any directory component and anything not safe in a filename. The result is only ever used
 * for display and for its extension — what actually lands on disk is named by a generated id — but
 * it still goes through this, because it is echoed back to the client and stored in the index.
 */
function sanitizeName(name: string): string {
  const base = path.basename(name).replace(/[\x00-\x1f<>:\"/\\|?*]/g, '').trim();
  return base.slice(0, 180) || 'imported-media';
}

function classify(extension: string, probe: ProbeResult): MediaAsset['type'] {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (probe.videoCodec && STILL_IMAGE_CODECS.has(probe.videoCodec) && probe.durationSeconds === 0) return 'image';
  if (probe.videoCodec && probe.width > 0) return 'video';
  if (probe.audioCodec) return 'audio';
  return 'video';
}

function formatBitrate(bitrateBps: number): string {
  if (!bitrateBps) return '—';
  if (bitrateBps >= 1e6) return `${(bitrateBps / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bitrateBps / 1e3)} kbps`;
}

/**
 * Reads duration, geometry, rate and codecs in one ffprobe pass.
 *
 * Rejects rather than returning defaults when ffprobe fails: an unreadable file is one the
 * timeline could not play either, so it is better for the import to fail loudly at the point the
 * operator chose the file than to land a zero-length asset that mysteriously does nothing.
 */
function probeMedia(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate',
      '-of', 'json',
      file,
    ];

    const proc = spawn(FFPROBE, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 60_000);

    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.slice(-300) || `ffprobe exited ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(out || '{}');
        const streams: Array<Record<string, unknown>> = parsed.streams ?? [];
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');

        // r_frame_rate is a rational ("25/1", "30000/1001"); 0/0 for streams with no meaningful
        // rate, which is why the denominator is checked before dividing.
        let fps = 0;
        const rate = String(video?.r_frame_rate ?? '');
        const [num, den] = rate.split('/').map(Number);
        if (num > 0 && den > 0) fps = Math.round((num / den) * 100) / 100;

        resolve({
          durationSeconds: Number(parsed.format?.duration) || 0,
          fps,
          width: Number(video?.width) || 0,
          height: Number(video?.height) || 0,
          videoCodec: video ? String(video.codec_name ?? '') || null : null,
          audioCodec: audio ? String(audio.codec_name ?? '') || null : null,
          bitrateBps: Number(parsed.format?.bit_rate) || 0,
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error('Could not parse ffprobe output'));
      }
    });
  });
}

/**
 * Extracts a poster frame for a video import.
 *
 * Without one an imported clip is a blank block on the timeline while a recorded segment beside it
 * shows a filmstrip — the recorder's own pipeline generates thumbnails, so anything imported has to
 * generate its own or it looks broken next to them. TimelineClip tiles this image across the clip
 * body (background-repeat: repeat-x), which is the same treatment a recorded segment's thumbnail
 * gets, so one representative frame is all that is needed.
 *
 * Best effort: an import with no thumbnail is still a usable import, so a failure here returns
 * undefined rather than failing the upload the operator already waited for.
 */
function buildThumbnail(file: string, id: string, durationSeconds: number): Promise<string | undefined> {
  const outputName = `${id}.jpg`;
  const outputPath = path.join(IMPORT_DIR, outputName);

  // A frame from a little way in, because the first frame of a source is very often black or a
  // fade — useless as the image that identifies the clip. Clamped for sources shorter than that.
  const seekSeconds = Math.min(3, Math.max(0, durationSeconds / 2));

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-ss", seekSeconds.toFixed(3),
    "-i", file,
    "-frames:v", "1",
    // Height fixed, width auto: the clip body is tiled horizontally at track height, so only the
    // vertical resolution matters and anything larger is wasted bytes on every timeline redraw.
    "-vf", "scale=-2:96",
    "-q:v", "4",
    outputPath,
  ];

  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_FOR_THUMBS, args, { windowsHide: true });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 30_000);

    proc.on("error", () => { clearTimeout(timer); resolve(undefined); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(`${IMPORT_URL_PREFIX}/${outputName}`);
        return;
      }
      try { fs.unlinkSync(outputPath); } catch { /* nothing to remove */ }
      resolve(undefined);
    });
  });
}

/**
 * POST /api/media/import?name=<original filename>
 *
 * The file is the raw request body, streamed straight to disk. Deliberately not multipart: a
 * multipart parser would add a dependency and, in most default configurations, buffer the whole
 * upload in memory or a temp file first — unworkable for the multi-gigabyte sources this is for.
 * Streaming the body keeps memory flat regardless of file size.
 */
export async function importMedia(req: Request, res: Response): Promise<void> {
  const originalName = sanitizeName(String(req.query.name ?? ''));
  const extension = path.extname(originalName).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    res.status(400).json({
      success: false,
      error: `'${extension || originalName}' is not a supported media type.`,
    });
    return;
  }

  // Stored under a generated id, so two imports of files with the same name cannot overwrite each
  // other and nothing in the request can influence the path written to.
  const id = randomUUID();
  const storedName = `${id}${extension}`;
  const destination = path.join(IMPORT_DIR, storedName);

  try {
    await pipeline(req, fs.createWriteStream(destination));
  } catch (error) {
    // A half-written file is worse than none: it probes as valid-ish and plays as corrupt.
    try { fs.unlinkSync(destination); } catch { /* nothing to clean up */ }
    logger.error(`Media import failed while writing '${originalName}'`, error);
    res.status(500).json({ success: false, error: 'Upload failed while writing the file.' });
    return;
  }

  const sizeBytes = (() => {
    try { return fs.statSync(destination).size; } catch { return 0; }
  })();

  if (sizeBytes === 0) {
    try { fs.unlinkSync(destination); } catch { /* nothing to clean up */ }
    res.status(400).json({ success: false, error: 'The uploaded file was empty.' });
    return;
  }

  let probe: ProbeResult;
  try {
    probe = await probeMedia(destination);
  } catch (error) {
    try { fs.unlinkSync(destination); } catch { /* nothing to clean up */ }
    logger.warn(`Media import rejected '${originalName}': ${error instanceof Error ? error.message : String(error)}`);
    res.status(400).json({
      success: false,
      error: 'That file could not be read as media. It may be corrupt or in an unsupported format.',
    });
    return;
  }

  const type = classify(extension, probe);
  // Audio has no frame to show — its waveform is what identifies it on the timeline and in the
  // browser — so only visual media gets one.
  const thumbnail = type === 'audio'
    ? undefined
    : await buildThumbnail(destination, id, probe.durationSeconds);

  const asset: MediaAsset = {
    id,
    name: originalName,
    path: `${IMPORT_URL_PREFIX}/${storedName}`,
    type,
    duration: Math.round(probe.durationSeconds * 100) / 100,
    fps: probe.fps,
    resolution: probe.width && probe.height ? `${probe.width}x${probe.height}` : '—',
    codec: probe.videoCodec ?? probe.audioCodec ?? '—',
    bitrate: formatBitrate(probe.bitrateBps),
    sizeBytes,
    hasAudio: probe.audioCodec !== null,
    thumbnail,
    createdAt: new Date().toISOString(),
  };

  const assets = readIndex();
  assets.unshift(asset);
  writeIndex(assets);

  logger.info(`Imported media '${originalName}' (${type}, ${asset.duration}s) as ${storedName}`);
  res.json({ success: true, data: asset });
}

/**
 * GET /api/media/imports → every asset imported into this project.
 *
 * Backfills thumbnails for anything imported before they were generated. Done lazily on read
 * rather than as a migration because it is self-limiting — each asset needs one poster frame, once
 * — and it means an existing library heals itself the first time the browser asks for it instead
 * of staying permanently pictureless on the timeline.
 */
export async function getImportedMedia(_req: Request, res: Response): Promise<void> {
  const assets = readIndex();

  const missing = assets.filter(
    (asset) => !asset.thumbnail && asset.type !== 'audio' && fs.existsSync(path.join(IMPORT_DIR, path.basename(asset.path))),
  );

  if (missing.length) {
    for (const asset of missing) {
      asset.thumbnail = await buildThumbnail(
        path.join(IMPORT_DIR, path.basename(asset.path)),
        asset.id,
        asset.duration,
      );
    }
    // Only rewritten when something was actually produced, so a source that cannot yield a frame
    // isn't re-attempted forever on every list.
    if (missing.some((asset) => asset.thumbnail)) writeIndex(assets);
  }

  res.json({ success: true, data: assets });
}
