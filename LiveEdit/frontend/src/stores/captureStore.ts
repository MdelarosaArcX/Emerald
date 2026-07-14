import { api } from '@/services/api';
import { getSocket, SOCKET_EVENTS } from '@/services/socket';
import type { CaptureInfo } from '@/types/project';
import { defineStore } from 'pinia';

interface CaptureState {
  info: CaptureInfo;
  loading: boolean;
}

export const useCaptureStore = defineStore('capture', {
  state: (): CaptureState => ({
    info: {
      localPath: '',
      title: '',
      description: '',
      duration: 0,
      fps: 0,
      resolution: '-',
      codec: '-',
      bitrate: '-',
      isCapturing: false,
    },
    loading: false,
  }),

  actions: {
    subscribeToSocket(): void {
      getSocket().on(SOCKET_EVENTS.CAPTURE_UPDATED, (payload: CaptureInfo) => {
        this.info = { ...this.info, ...payload };
      });
    },

    setInfo(info: CaptureInfo): void {
      this.info = info;
    },

    async startCapture(): Promise<void> {
      this.loading = true;
      try {
        this.info = await api.toggleCapture('start');
      } finally {
        this.loading = false;
      }
    },

    async stopCapture(): Promise<void> {
      this.loading = true;
      try {
        this.info = await api.toggleCapture('stop');
      } finally {
        this.loading = false;
      }
    },

    async importMedia(name: string, path: string, type: 'video' | 'audio' | 'image'): Promise<void> {
      await api.importMedia({ name, path, type });
    },
  },
});
