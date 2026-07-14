import { io, Socket } from 'socket.io-client';

/** Socket.IO event names shared with the backend. Keep in sync with backend/src/sockets/index.ts */
export const SOCKET_EVENTS = {
  PLAYHEAD_CHANGED: 'playheadChanged',
  TIMELINE_UPDATED: 'timelineUpdated',
  CAPTURE_UPDATED: 'captureUpdated',
  PLAYBACK_UPDATED: 'playbackUpdated',
  RECORDING_CHANGED: 'recordingChanged',
} as const;

let socket: Socket | null = null;

/** Lazily creates and returns the shared Socket.IO client instance. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io('/', {
      path: '/socket.io',
      autoConnect: true,
      transports: ['websocket'],
    });
  }
  return socket;
}
