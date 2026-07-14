import { getSocket, SOCKET_EVENTS } from '@/services/socket';
import { onBeforeUnmount, onMounted } from 'vue';

type EventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

/**
 * Subscribes to a Socket.IO event for the lifetime of the calling component,
 * automatically detaching the listener on unmount.
 */
export function useSocketEvent<T = unknown>(event: EventName, handler: (payload: T) => void): void {
  const socket = getSocket();

  onMounted(() => {
    socket.on(event, handler);
  });

  onBeforeUnmount(() => {
    socket.off(event, handler);
  });
}

/** Returns the shared Socket.IO client for imperative emit calls. */
export function useSocket() {
  return getSocket();
}
