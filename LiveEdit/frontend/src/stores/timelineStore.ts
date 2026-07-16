import { api } from '@/services/api';
import { getSocket, SOCKET_EVENTS } from '@/services/socket';
import type { Clip, Timeline, Track } from '@/types/clip';
import { defineStore } from 'pinia';

interface TimelineState {
  timeline: Timeline | null;
  selectedClipId: string | null;
  zoom: number;
  snapEnabled: boolean;
  loading: boolean;
  error: string | null;
  mouseFrame: number | null;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

export const useTimelineStore = defineStore('timeline', {
  state: (): TimelineState => ({
    timeline: null,
    selectedClipId: null,
    zoom: 1,
    snapEnabled: true,
    loading: false,
    error: null,
    mouseFrame: null,
  }),

  getters: {
    tracks(state): Track[] {
      return state.timeline?.tracks.slice().sort((a, b) => a.order - b.order) ?? [];
    },
    videoTracks(): Track[] {
      return this.tracks.filter((t) => t.kind === 'video' || t.kind === 'fx');
    },
    audioTracks(): Track[] {
      return this.tracks.filter((t) => t.kind === 'audio');
    },
    allClips(state): Clip[] {
      return state.timeline?.tracks.flatMap((t) => t.clips) ?? [];
    },
    selectedClip(): Clip | null {
      return this.allClips.find((c) => c.id === this.selectedClipId) ?? null;
    },
    playhead(state): number {
      return state.timeline?.playhead ?? 0;
    },
    fps(state): number {
      return state.timeline?.fps ?? 29.97;
    },
    duration(state): number {
      return state.timeline?.duration ?? 0;
    },
  },

  actions: {
    async fetchTimeline(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        this.timeline = await api.getTimeline();
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Failed to load timeline';
      } finally {
        this.loading = false;
      }
    },

    subscribeToSocket(): void {
      const socket = getSocket();
      socket.on(SOCKET_EVENTS.PLAYHEAD_CHANGED, (payload: { playhead: number }) => {
        this.setPlayhead(payload.playhead, false);
      });
      socket.on(SOCKET_EVENTS.TIMELINE_UPDATED, (timeline: Timeline) => {
        this.timeline = timeline;
      });
    },

    selectClip(clipId: string | null): void {
      this.selectedClipId = clipId;
    },

    setPlayhead(frames: number, emit = true): void {
      if (!this.timeline) return;
      this.timeline.playhead = Math.max(0, Math.min(frames, this.timeline.duration));
      if (emit) {
        getSocket().emit(SOCKET_EVENTS.PLAYHEAD_CHANGED, { playhead: this.timeline.playhead });
      }
    },

    /**
     * Rebuilds the timeline around a clip loaded into the Program monitor: one video lane (with a
     * thumbnail filmstrip) and one audio lane, both spanning the clip's real frame count at its
     * real fps — so the ruler, playhead and scrubbing all operate frame-for-frame on that clip.
     */
    loadProgramClip(payload: { name: string; thumbnail: string; durationFrames: number; fps: number }): void {
      const duration = Math.max(1, Math.round(payload.durationFrames));
      const base = {
        path: '',
        start: 0,
        trimIn: 0,
        trimOut: duration,
        duration,
        effects: [],
        opacity: 100,
        rotation: 0,
        scale: 100,
        position: { x: 0, y: 0 },
        speed: 1,
        volume: 100,
        locked: false,
      };
      const videoClip: Clip = { ...base, id: 'program-clip', name: payload.name, track: 'v1', color: '#14b8a6', type: 'video', thumbnail: payload.thumbnail };
      const audioClip: Clip = { ...base, id: 'program-audio', name: `${payload.name} · audio`, track: 'a1', color: '#34d399', type: 'audio' };

      this.timeline = {
        id: 'program-timeline',
        fps: payload.fps,
        duration,
        playhead: 0,
        tracks: [
          { id: 'v1', name: 'V1', kind: 'video', order: 0, height: 76, locked: false, visible: true, muted: false, solo: false, clips: [videoClip] },
          { id: 'a1', name: 'A1', kind: 'audio', order: 1, height: 60, locked: false, visible: true, muted: false, solo: false, clips: [audioClip] },
        ],
      };
      this.selectedClipId = 'program-clip';
    },

    updateClip(clipId: string, patch: Partial<Clip>): void {
      const clip = this.allClips.find((c) => c.id === clipId);
      if (clip) Object.assign(clip, patch);
    },

    moveClipToTrack(clipId: string, trackId: string): void {
      if (!this.timeline) return;
      let moving: Clip | undefined;
      for (const track of this.timeline.tracks) {
        const idx = track.clips.findIndex((c) => c.id === clipId);
        if (idx !== -1) {
          [moving] = track.clips.splice(idx, 1);
          break;
        }
      }
      if (!moving) return;
      moving.track = trackId;
      const target = this.timeline.tracks.find((t) => t.id === trackId);
      target?.clips.push(moving);
    },

    toggleTrackLock(trackId: string): void {
      const track = this.timeline?.tracks.find((t) => t.id === trackId);
      if (track) track.locked = !track.locked;
    },

    toggleTrackVisibility(trackId: string): void {
      const track = this.timeline?.tracks.find((t) => t.id === trackId);
      if (track) track.visible = !track.visible;
    },

    toggleTrackMute(trackId: string): void {
      const track = this.timeline?.tracks.find((t) => t.id === trackId);
      if (track) track.muted = !track.muted;
    },

    toggleTrackSolo(trackId: string): void {
      const track = this.timeline?.tracks.find((t) => t.id === trackId);
      if (track) track.solo = !track.solo;
    },

    resizeTrackHeight(trackId: string, height: number): void {
      const track = this.timeline?.tracks.find((t) => t.id === trackId);
      if (track) track.height = Math.max(32, Math.min(200, height));
    },

    setZoom(zoom: number): void {
      this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    },

    zoomIn(): void {
      this.setZoom(this.zoom * 1.25);
    },

    zoomOut(): void {
      this.setZoom(this.zoom / 1.25);
    },

    toggleSnap(): void {
      this.snapEnabled = !this.snapEnabled;
    },

    setMouseFrame(frame: number | null): void {
      this.mouseFrame = frame;
    },

    reorderTracks(orderedIds: string[]): void {
      if (!this.timeline) return;
      orderedIds.forEach((id, index) => {
        const track = this.timeline!.tracks.find((t) => t.id === id);
        if (track) track.order = index;
      });
    },
  },
});
