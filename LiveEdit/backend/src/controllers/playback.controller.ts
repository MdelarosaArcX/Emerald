import { Request, Response } from 'express';
import { playbackInfo, systemStatus, timeline } from '../data/mockData';
import { getSocketServer, SOCKET_EVENTS } from '../sockets';
import { logger } from '../utils/logger';

/**
 * POST /api/play
 * Marks playback as active and broadcasts the change over Socket.IO.
 * Actual media playback is handled client-side (Video.js) - this endpoint
 * only tracks/synchronizes transport state across connected clients.
 */
export function play(req: Request, res: Response): void {
  const { clipId } = req.body as { clipId?: string };

  playbackInfo.isPlaying = true;
  if (clipId) {
    playbackInfo.clipId = clipId;
  }
  systemStatus.playing = true;

  try {
    getSocketServer().emit(SOCKET_EVENTS.PLAYBACK_UPDATED, playbackInfo);
  } catch (err) {
    logger.warn('Socket server not ready when emitting playback update', err);
  }

  res.json({ success: true, data: playbackInfo });
}

/**
 * POST /api/pause
 * Marks playback as paused and broadcasts the change over Socket.IO.
 */
export function pause(_req: Request, res: Response): void {
  playbackInfo.isPlaying = false;
  systemStatus.playing = false;

  try {
    getSocketServer().emit(SOCKET_EVENTS.PLAYBACK_UPDATED, playbackInfo);
  } catch (err) {
    logger.warn('Socket server not ready when emitting playback update', err);
  }

  res.json({ success: true, data: playbackInfo });
}

/**
 * POST /api/stop
 * Stops playback, resets the playhead, and broadcasts both changes.
 */
export function stop(_req: Request, res: Response): void {
  playbackInfo.isPlaying = false;
  playbackInfo.currentTime = 0;
  systemStatus.playing = false;
  timeline.playhead = 0;

  try {
    const io = getSocketServer();
    io.emit(SOCKET_EVENTS.PLAYBACK_UPDATED, playbackInfo);
    io.emit(SOCKET_EVENTS.PLAYHEAD_CHANGED, { playhead: timeline.playhead });
  } catch (err) {
    logger.warn('Socket server not ready when emitting stop update', err);
  }

  res.json({ success: true, data: playbackInfo });
}
