import { api } from '@/services/api';
import { getSocket, SOCKET_EVENTS } from '@/services/socket';
import type { PlaybackInfo } from '@/types/project';
import { defineStore } from 'pinia';

interface PlaybackState {
  info: PlaybackInfo;
  playbackRateOptions: number[];
  loading: boolean;
}

export const usePlaybackStore = defineStore('playback', {
  state: (): PlaybackState => ({
    info: {
      clipId: null,
      filePath: '',
      duration: 0,
      fps: 29.97,
      resolution: '-',
      codec: '-',
      audioChannels: 2,
      currentTime: 0,
      isPlaying: false,
      volume: 80,
      speed: 1,
    },
    playbackRateOptions: [0.25, 0.5, 1, 1.5, 2],
    loading: false,
  }),

  actions: {
    subscribeToSocket(): void {
      getSocket().on(SOCKET_EVENTS.PLAYBACK_UPDATED, (payload: PlaybackInfo) => {
        this.info = { ...this.info, ...payload };
      });
    },

    async play(clipId?: string): Promise<void> {
      this.loading = true;
      try {
        this.info = await api.play(clipId);
      } finally {
        this.loading = false;
      }
    },

    async pause(): Promise<void> {
      this.info = await api.pause();
    },

    async stop(): Promise<void> {
      this.info = await api.stop();
    },

    setCurrentTime(seconds: number): void {
      this.info.currentTime = seconds;
    },

    setVolume(volume: number): void {
      this.info.volume = Math.max(0, Math.min(100, volume));
    },

    setSpeed(speed: number): void {
      this.info.speed = speed;
    },
  },
});
