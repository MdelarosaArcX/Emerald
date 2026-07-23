import { defineStore } from 'pinia';
import type { RecordedClip } from '@/services/emeraldPreview';

/**
 * The clip currently loaded into the center Program monitor for viewing/editing — sourced from
 * the Emerald backend's recorded clips (separate from playbackStore, which tracks the on-air
 * feed). Holds live metadata read off the <video> element (duration/resolution) plus transport
 * state, so the monitor, timeline, and inspector all stay in sync frame-for-frame.
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

// Emerald records at 25 fps (recorder default); used for frame math until we can read the real
// per-file rate. The browser can't report fps from a <video>, so this is the working assumption.
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
    resolution: (state): string => (state.width && state.height ? `${state.width}x${state.height}` : '—'),
    durationFrames: (state): number => Math.round(state.durationSeconds * state.fps),
    currentFrame: (state): number => Math.round(state.currentTimeSeconds * state.fps),
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

    clear(): void {
      this.clip = null;
      this.durationSeconds = 0;
      this.currentTimeSeconds = 0;
      this.isPlaying = false;
    },
  },
});
