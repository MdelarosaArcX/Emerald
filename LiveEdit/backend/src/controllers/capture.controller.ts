import { Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { captureInfo, mediaAssets, systemStatus } from '../data/mockData';
import { getSocketServer, SOCKET_EVENTS } from '../sockets';
import { logger } from '../utils/logger';
//
/**
 * POST /api/import
 * Registers an externally-selected media file into the project's
 * media asset list. Does not perform any transcoding.
 */
export function importMedia(req: Request, res: Response): void {
  const { name, path, type } = req.body as { name?: string; path?: string; type?: 'video' | 'audio' | 'image' };

  if (!name || !path || !type) {
    res.status(400).json({ success: false, error: 'name, path, and type are required.' });
    return;
  }

  const asset = {
    id: uuid(),
    name,
    path,
    type,
    duration: 0,
    fps: 0,
    resolution: '-',
    codec: '-',
    bitrate: '-',
    sizeBytes: 0,
    createdAt: new Date().toISOString(),
  };

  mediaAssets.push(asset);
  res.status(201).json({ success: true, data: asset });
}

/**
 * POST /api/capture
 * Toggles a capture/recording session. Actual ingest (FFmpeg) is
 * intentionally not implemented - this only tracks session state.
 */
export function toggleCapture(req: Request, res: Response): void {
  const { action } = req.body as { action?: 'start' | 'stop' };

  captureInfo.isCapturing = action === 'start';
  systemStatus.recording = captureInfo.isCapturing;

  try {
    const io = getSocketServer();
    io.emit(SOCKET_EVENTS.CAPTURE_UPDATED, captureInfo);
    io.emit(SOCKET_EVENTS.RECORDING_CHANGED, { recording: systemStatus.recording });
  } catch (err) {
    logger.warn('Socket server not ready when emitting capture update', err);
  }

  res.json({ success: true, data: captureInfo });
}
