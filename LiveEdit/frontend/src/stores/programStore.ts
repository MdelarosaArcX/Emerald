import { defineStore } from 'pinia';
import type { RecordedClip } from '@/services/emeraldPreview';

/**
 * The recorded clip currently loaded into the center Program monitor for viewing/editing.
 * Holds live metadata read off the <video> element (duration/resolution) plus playback state so
 * the monitor and the right-hand information panel stay in sync.
 */
interface ProgramState {
  clip: RecordedClip | null;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  currentTimeSeconds: number;
  isPlaying: boolean;
}

// Emerald records at 25 fps; the browser can't report fps from a <video>, so this is the working
// assumption for frame math.
const DEFAULT_FPS = 25;

export const useProgramStore = defineStore('program', {
  state: (): ProgramState => ({
    clip: null,
    durationSeconds: 0,
    width: 0,
    height: 0,
    fps: DEFAULT_FPS,
    currentTimeSeconds: 0,
    isPlaying: false,
  }),

  getters: {
    resolution: (s): string => (s.width && s.height ? `${s.width}x${s.height}` : '—'),
    durationFrames: (s): number => Math.round(s.durationSeconds * s.fps),
    currentFrame: (s): number => Math.round(s.currentTimeSeconds * s.fps),
  },

  actions: {
    loadClip(clip: RecordedClip): void {
      this.clip = clip;
      this.durationSeconds = 0;
      this.width = 0;
      this.height = 0;
      this.currentTimeSeconds = 0;
      this.isPlaying = false;
    },
    setMeta(payload: { durationSeconds: number; width: number; height: number }): void {
      this.durationSeconds = payload.durationSeconds;
      this.width = payload.width;
      this.height = payload.height;
    },
    setCurrentTime(seconds: number): void {
      this.currentTimeSeconds = seconds;
    },
    setPlaying(value: boolean): void {
      this.isPlaying = value;
    },
  },
});
