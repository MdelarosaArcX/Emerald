import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '../utils/logger';

/**
 * Socket.IO event names shared between backend and frontend.
 * Keep in sync with frontend/src/services/socket.ts
 */
export const SOCKET_EVENTS = {
  PLAYHEAD_CHANGED: 'playheadChanged',
  TIMELINE_UPDATED: 'timelineUpdated',
  CAPTURE_UPDATED: 'captureUpdated',
  PLAYBACK_UPDATED: 'playbackUpdated',
  RECORDING_CHANGED: 'recordingChanged',
} as const;

let io: SocketIOServer | null = null;

/**
 * Initializes the Socket.IO server and attaches connection logging.
 * Call once from server.ts after the HTTP server is created.
 */
export function initSocketServer(httpServer: HttpServer, corsOrigin: string): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket: Socket) => {
    logger.info(`Socket connected: ${socket.id}`);

    socket.on('disconnect', (reason: string) => {
      logger.info(`Socket disconnected: ${socket.id} (${reason})`);
    });
  });

  return io;
}

/**
 * Returns the active Socket.IO server instance for emitting events
 * from REST controllers. Throws if called before initialization.
 */
export function getSocketServer(): SocketIOServer {
  if (!io) {
    throw new Error('Socket.IO server has not been initialized yet.');
  }
  return io;
}
