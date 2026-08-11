import { getSocketServer, SOCKET_EVENTS } from '../sockets';
import { logger } from '../utils/logger';

/**
 * Polls the main Emerald backend's edit-capture pipeline (the 2-minute segmented,
 * faststart-MP4-proxy capture built specifically for LiveEdit) for newly finished segments and
 * pushes them over Socket.IO so the frontend can append them to the timeline without any manual
 * refresh/drag. Polling (not fs.watch/push) matches how the Emerald backend itself detects
 * finished segments — see obsIngestService.js/editCaptureService.js reconcileSegments().
 */

const EMERALD_BACKEND_URL = (process.env.EMERALD_BACKEND_URL || 'http://10.0.0.32:5000').replace(/\/+$/, '');
const SYNC_INTERVAL_MS = Number(process.env.MEDIA_ASSET_SYNC_INTERVAL_MS) || 10000;

interface EditCaptureSession {
  folderName: string;
  status: 'recording' | 'stopped' | 'crashed';
}

interface EditCaptureSegment {
  index: number;
  fileName: string;
  proxyUrl: string | null;
  durationSeconds: number | null;
  hasAudio: boolean | null;
  createdAt: string;
}

export interface EditCaptureSegmentAddedPayload {
  folder: string;
  index: number;
  fileName: string;
  proxyUrl: string;
  durationSeconds: number;
  hasAudio: boolean;
  createdAt: string;
}

let currentFolder: string | null = null;
let knownIndices = new Set<number>();
// Folders actually observed recording (status === 'recording') at some point during this
// process's uptime — distinct from currentFolder, which just tracks whichever folder
// sessions?.[0] most recently pointed at. Gates auto-append to genuinely-live sessions only (see
// the status check in poll() below).
const liveFolders = new Set<string>();

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${EMERALD_BACKEND_URL}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    logger.warn(`edit-capture sync: request to ${path} failed`, err);
    return null;
  }
}

async function poll(): Promise<void> {
  const sessions = await fetchJson<EditCaptureSession[]>('/api/edit-capture/sessions');
  const session = sessions?.[0];
  if (!session) return;

  if (session.folderName !== currentFolder) {
    // New capture session started — segment indices restart from 0 in the new folder, so the
    // "already announced" set from the previous session no longer applies.
    currentFolder = session.folderName;
    knownIndices = new Set();
  }

  // Auto-append to the timeline is meant for the *live* folder only. A session already stopped
  // before we ever saw it recording (e.g. right after a backend restart, when knownIndices/
  // liveFolders both reset to empty but sessions?.[0] can still be a session that finished hours
  // ago) is never added — but a session we genuinely watched recording earlier in this process's
  // uptime still gets its final segment(s) picked up after it stops, same as before.
  if (session.status === 'recording') {
    liveFolders.add(session.folderName);
  } else if (!liveFolders.has(session.folderName)) {
    return;
  }

  const segments = await fetchJson<EditCaptureSegment[]>(
    `/api/edit-capture/sessions/${encodeURIComponent(session.folderName)}/segments`,
  );
  if (!segments) return;

  const sorted = segments.slice().sort((a, b) => a.index - b.index);
  // The highest-indexed segment may still be mid-write while the session is actively recording —
  // same rule the Emerald backend's own reconcileSegments() uses before trusting a segment is done.
  const finished = session.status === 'recording' ? sorted.slice(0, -1) : sorted;

  for (const segment of finished) {
    if (knownIndices.has(segment.index)) continue;
    // durationSeconds/proxyUrl land a beat after the file appears on disk (ffprobe + proxy mux
    // both run asynchronously on the Emerald backend) — skip for now, picked up on a later tick.
    if (!segment.proxyUrl || segment.durationSeconds == null) continue;

    const io = (() => {
      try {
        return getSocketServer();
      } catch {
        return null;
      }
    })();
    if (!io) continue;

    io.emit(SOCKET_EVENTS.EDIT_CAPTURE_SEGMENT_ADDED, {
      folder: session.folderName,
      index: segment.index,
      fileName: segment.fileName,
      proxyUrl: `${EMERALD_BACKEND_URL}${segment.proxyUrl}`,
      durationSeconds: segment.durationSeconds,
      hasAudio: segment.hasAudio ?? true,
      createdAt: segment.createdAt,
    } satisfies EditCaptureSegmentAddedPayload);

    knownIndices.add(segment.index);
  }
}

/** Starts the recurring poll. Call once from server.ts after the Socket.IO server is created. */
export function startEditCaptureSync(): void {
  logger.info(`Edit-capture sync: polling ${EMERALD_BACKEND_URL} every ${SYNC_INTERVAL_MS}ms`);
  setInterval(() => {
    poll().catch((err) => logger.error('edit-capture sync tick failed', err));
  }, SYNC_INTERVAL_MS);
}
