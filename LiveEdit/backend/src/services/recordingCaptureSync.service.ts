import { getSocketServer, SOCKET_EVENTS } from '../sockets';
import { logger } from '../utils/logger';
import { isSameMachine } from '../utils/deploymentTopology';
import { LOCAL_RECORDINGS_AVAILABLE } from '../utils/localRecordings';
import type { EditCaptureSegmentAddedPayload } from './editCaptureSync.service';

/**
 * Polls the main Emerald backend's REGULAR recording pipeline (obsIngestService.js — started
 * from the Capture page's Record button) for newly finished 2-minute proxy (.mp4) segments and
 * pushes them to the timeline the same way editCaptureSync.service.ts does for the separate
 * uncompressed edit-capture pipeline. Most deployments actually record via this pipeline, not
 * edit-capture, so V4 needs to watch this one too — same EDIT_CAPTURE_SEGMENT_ADDED event and
 * payload shape, since the frontend's appendCaptureSegment() doesn't care which pipeline a
 * segment came from.
 */

const EMERALD_BACKEND_URL = (process.env.EMERALD_BACKEND_URL || 'http://10.0.0.32:5000').replace(/\/+$/, '');
const SYNC_INTERVAL_MS = Number(process.env.MEDIA_ASSET_SYNC_INTERVAL_MS) || 10000;
const SEGMENT_FILE_PATTERN = /^emerald-(\d+)\.mp4$/i;
const LIVEEDIT_PUBLIC_ORIGIN = `http://localhost:${Number(process.env.PORT) || 4000}`;

interface RecordingStatus {
  isRecording: boolean;
  outputPattern: string | null;
}

interface RecordingSegment {
  fileName: string;
  kind: 'mp4' | 'ts';
  url: string;
  createdAt: string;
  durationSeconds: number | null;
  hasAudio: boolean | null;
}

// Only ever the folder we've actually observed with isRecording === true — never adopted just
// because it's the most recent one on disk, so a stale already-finished session sitting there at
// backend startup is never (re-)pushed to the timeline (the same "live folder only" rule
// editCaptureSync.service.ts enforces for its own pipeline).
let trackedFolder: string | null = null;
let knownIndices = new Set<number>();

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${EMERALD_BACKEND_URL}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    logger.warn(`recording sync: request to ${path} failed`, err);
    return null;
  }
}

/** outputPattern is e.g. ".../Recordings/emerald072720262023/emerald-%03d.mp4" — the session's folder is its parent directory. */
function folderFromOutputPattern(outputPattern: string): string | null {
  const parts = outputPattern.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.pop() || null;
}

/**
 * relativeUrl is Emerald's own "/recordings/<folder>/<file>" path. When Emerald and LiveEdit are
 * on the same machine and EMERALD_RECORDINGS_PATH points at a real local copy of that folder, the
 * frontend gets a URL served directly off local disk by this backend's own /local-recordings
 * static route instead of an HTTP fetch to the Emerald backend for the same bytes.
 */
async function buildProxyUrl(relativeUrl: string): Promise<string> {
  if (LOCAL_RECORDINGS_AVAILABLE) {
    const emeraldHost = new URL(EMERALD_BACKEND_URL).hostname;
    if (await isSameMachine(emeraldHost)) {
      return `${LIVEEDIT_PUBLIC_ORIGIN}${relativeUrl.replace(/^\/recordings\//, '/local-recordings/')}`;
    }
  }
  return `${EMERALD_BACKEND_URL}${relativeUrl}`;
}

async function poll(): Promise<void> {
  const status = await fetchJson<RecordingStatus>('/api/obs-recording/status');
  if (!status?.outputPattern) return;

  const folder = folderFromOutputPattern(status.outputPattern);
  if (!folder) return;

  if (status.isRecording) {
    if (folder !== trackedFolder) {
      // New recording session started — segment indices restart in the new folder, so the
      // "already announced" set from the previous session no longer applies.
      trackedFolder = folder;
      knownIndices = new Set();
    }
  } else if (folder !== trackedFolder) {
    // Not recording, and this isn't the folder we were just tracking — either nothing has ever
    // recorded yet, or this is a stale already-finished session sitting on disk from before this
    // process started. Either way, never adopt it.
    return;
  }
  // else: folder === trackedFolder and recording just stopped — fall through once more so this
  // session's final segment (excluded from every prior tick's `finished` while still writing)
  // still gets caught, instead of being silently dropped the instant isRecording flips false.

  if (!trackedFolder) return;

  const segments = await fetchJson<RecordingSegment[]>(
    `/api/recording-sessions/${encodeURIComponent(trackedFolder)}/segments`,
  );
  if (!segments) return;

  const mp4Segments = segments
    .filter((s) => s.kind === 'mp4')
    .map((s) => {
      const match = SEGMENT_FILE_PATTERN.exec(s.fileName);
      return match ? { ...s, index: Number(match[1]) } : null;
    })
    .filter((s): s is RecordingSegment & { index: number } => s !== null)
    .sort((a, b) => a.index - b.index);

  // The highest-indexed segment can still be mid-write while recording is active — same rule
  // obsIngestService.js's own reconcileSegments() uses before trusting a segment is done.
  const finished = status.isRecording ? mp4Segments.slice(0, -1) : mp4Segments;

  for (const segment of finished) {
    if (knownIndices.has(segment.index)) continue;
    // durationSeconds lands a beat after the file appears on disk (ffprobe hasn't finished, or
    // the still-writing file can't be probed yet) — skip for now, picked up on a later tick.
    if (segment.durationSeconds == null) continue;

    const io = (() => {
      try {
        return getSocketServer();
      } catch {
        return null;
      }
    })();
    if (!io) continue;

    io.emit(SOCKET_EVENTS.EDIT_CAPTURE_SEGMENT_ADDED, {
      folder: trackedFolder,
      index: segment.index,
      fileName: segment.fileName,
      proxyUrl: await buildProxyUrl(segment.url),
      durationSeconds: segment.durationSeconds,
      hasAudio: segment.hasAudio ?? true,
      createdAt: segment.createdAt,
    } satisfies EditCaptureSegmentAddedPayload);

    knownIndices.add(segment.index);
  }
}

/** Starts the recurring poll. Call once from server.ts after the Socket.IO server is created. */
export function startRecordingCaptureSync(): void {
  logger.info(`Recording sync: polling ${EMERALD_BACKEND_URL} every ${SYNC_INTERVAL_MS}ms`);
  setInterval(() => {
    poll().catch((err) => logger.error('recording sync tick failed', err));
  }, SYNC_INTERVAL_MS);
}
