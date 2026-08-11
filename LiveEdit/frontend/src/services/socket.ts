import { io, Socket } from 'socket.io-client';

/** Socket.IO event names shared with the backend. Keep in sync with backend/src/sockets/index.ts */
export const SOCKET_EVENTS = {
  PLAYHEAD_CHANGED: 'playheadChanged',
  TIMELINE_UPDATED: 'timelineUpdated',
  CAPTURE_UPDATED: 'captureUpdated',
  PLAYBACK_UPDATED: 'playbackUpdated',
  RECORDING_CHANGED: 'recordingChanged',
  // A single edit-capture segment has finished writing and is ready to be dropped onto the
  // timeline. Distinct from RECORDING_CHANGED (capture on/off state).
  EDIT_CAPTURE_SEGMENT_ADDED: 'editCaptureSegmentAdded',
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
