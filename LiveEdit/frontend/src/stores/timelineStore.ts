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
  /** Frame up to which the timeline has gone/is going to air (0 = nothing on air). Drives the red
   *  on-air highlight. */
  onAirFrame: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

/** Unique-enough id for clips created at runtime (drag-insert, split). */
function newClipId(): string {
  return `clip-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Unique-enough id for tracks created at runtime. */
function newTrackId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/**
 * Build one recorded segment as a clip on the shared session track, placed at `start`.
 * Stable id per folder+file so live appends never double-add.
 */
function makeSegmentClip(
  folder: string,
  seg: number,
  s: { fileName: string; url: string; thumbnail?: string },
  start: number,
  trackId: string,
): Clip {
  return {
    id: `c-${folder}-${s.fileName}`,
    name: s.fileName,
    path: s.url,
    track: trackId,
    start,
    duration: seg,
    trimIn: 0,
    trimOut: seg,
    color: '#14b8a6',
    effects: [],
    type: 'video',
    thumbnail: s.thumbnail,
    opacity: 100,
    rotation: 0,
    scale: 100,
    position: { x: 0, y: 0 },
    speed: 1,
    volume: 100,
    locked: false,
    autoFit: true,
  };
}

/** The single video lane every session segment is placed on. */
function makeSessionTrack(trackId: string, clips: Clip[]): Track {
  return { id: trackId, name: 'V1', kind: 'video', order: 0, height: 56, locked: false, visible: true, muted: false, solo: false, clips };
}

export const useTimelineStore = defineStore('timeline', {
  state: (): TimelineState => ({
    timeline: null,
    selectedClipId: null,
    zoom: 1,
    snapEnabled: true,
    loading: false,
    error: null,
    mouseFrame: null,
    onAirFrame: 0,
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
      const dur = Number.isFinite(this.timeline.duration) ? this.timeline.duration : 0;
      const f = Number.isFinite(frames) ? frames : 0;
      this.timeline.playhead = Math.max(0, Math.min(f, dur));
      if (emit) {
        getSocket().emit(SOCKET_EVENTS.PLAYHEAD_CHANGED, { playhead: this.timeline.playhead });
      }
    },

    /** Set the on-air frame (up to which the timeline has gone to air). Non-finite → 0. */
    setOnAirFrame(frame: number): void {
      this.onAirFrame = Number.isFinite(frame) && frame > 0 ? frame : 0;
    },

    /**
     * Rebuilds the timeline around a clip loaded into the Program monitor: one video lane (with a
     * thumbnail filmstrip) and one audio lane, both spanning the clip's real frame count at its
     * real fps — so the ruler, playhead and scrubbing all operate frame-for-frame on that clip.
     */
    loadProgramClip(payload: { name: string; thumbnail: string; durationFrames: number; fps: number; url?: string }): void {
      const duration = Math.max(1, Math.round(payload.durationFrames));
      const base = {
        path: payload.url ?? '',
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
        autoFit: true,
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

    /**
     * Build a fresh timeline from a recording session's segments, laid out back-to-back on a video
     * lane (+ paired audio). Used to load a whole session for editing; live sessions then keep
     * appending via appendSessionSegments().
     */
    loadSession(payload: { folder: string; fps: number; nominalSeconds: number; segments: { fileName: string; url: string; thumbnail?: string; index: number }[] }): void {
      const fps = Number.isFinite(payload.fps) && payload.fps > 0 ? payload.fps : 25;
      const nominal = Number.isFinite(payload.nominalSeconds) && payload.nominalSeconds > 0 ? payload.nominalSeconds : 120;
      const seg = Math.max(1, Math.round(nominal * fps));
      const trackId = `t-${payload.folder}`;
      // All segments share ONE video lane, segmented by file and laid out left→right by timecode
      // (index × segment length) so they never overlap and the playhead sweeps across the sequence.
      const clips: Clip[] = payload.segments
        .map((s, i) => {
          const idx = Number.isFinite(s.index) ? s.index : i;
          return makeSegmentClip(payload.folder, seg, s, idx * seg, trackId);
        })
        .sort((a, b) => a.start - b.start);
      const duration = clips.reduce((m, c) => Math.max(m, c.start + c.duration), seg);
      this.timeline = {
        id: `session-${payload.folder}`,
        fps,
        duration: Math.max(1, duration),
        playhead: 0,
        tracks: [makeSessionTrack(trackId, clips)],
      };
      this.selectedClipId = null;
    },

    /** Append newly-recorded segments onto the shared session lane, positioned by timecode. Returns how many were added. */
    appendSessionSegments(payload: { folder: string; fps: number; nominalSeconds: number; segments: { fileName: string; url: string; thumbnail?: string; index: number }[] }): number {
      if (!this.timeline) return 0;
      const fps = Number.isFinite(payload.fps) && payload.fps > 0 ? payload.fps : (this.timeline.fps || 25);
      const nominal = Number.isFinite(payload.nominalSeconds) && payload.nominalSeconds > 0 ? payload.nominalSeconds : 120;
      const seg = Math.max(1, Math.round(nominal * fps));

      const trackId = `t-${payload.folder}`;
      let track = this.timeline.tracks.find((t) => t.id === trackId);
      if (!track) {
        track = makeSessionTrack(trackId, []);
        this.timeline.tracks.push(track);
      }
      const existingClips = new Set(track.clips.map((c) => c.id));
      let fallback = track.clips.length;
      let end = Number.isFinite(this.timeline.duration) ? this.timeline.duration : 0;
      let added = 0;
      for (const s of payload.segments) {
        if (existingClips.has(`c-${payload.folder}-${s.fileName}`)) continue;
        const idx = Number.isFinite(s.index) ? s.index : fallback;
        fallback += 1;
        const clip = makeSegmentClip(payload.folder, seg, s, idx * seg, trackId);
        track.clips.push(clip);
        end = Math.max(end, clip.start + clip.duration);
        added += 1;
      }
      if (added) {
        track.clips.sort((a, b) => a.start - b.start);
        this.timeline.duration = end;
      }
      return added;
    },

    /** Insert a clip (dragged from the media browser) onto a track at a given start frame. If it
     * would overlap an existing clip on the target track, a new track is created for it so clips
     * never overlap in time on the same lane. */
    addClipFromSource(payload: {
      name: string;
      url: string;
      thumbnail?: string;
      durationFrames: number;
      trackId: string;
      startFrame: number;
      kind?: 'video' | 'audio';
    }): string | null {
      let track = this.timeline?.tracks.find((t) => t.id === payload.trackId);
      if (!this.timeline || !track || track.locked) return null;

      const duration = Number.isFinite(payload.durationFrames) ? Math.max(1, Math.round(payload.durationFrames)) : 1;
      const isAudio = payload.kind === 'audio' || track.kind === 'audio';
      const start = Number.isFinite(payload.startFrame) ? Math.max(0, Math.round(payload.startFrame)) : 0;

      // If the drop overlaps an existing clip on this track, put it on a fresh track instead.
      const overlaps = (t: Track): boolean =>
        t.clips.some((c) => start < c.start + c.duration && c.start < start + duration);
      if (overlaps(track)) {
        const newId = this.addTrack(isAudio ? 'audio' : 'video');
        const created = this.timeline.tracks.find((t) => t.id === newId);
        if (created) track = created;
      }

      const id = newClipId();
      const clip: Clip = {
        id,
        name: payload.name,
        path: payload.url,
        track: track.id,
        start,
        duration,
        trimIn: 0,
        trimOut: duration,
        color: isAudio ? '#34d399' : '#14b8a6',
        effects: [],
        type: isAudio ? 'audio' : 'video',
        thumbnail: payload.thumbnail,
        opacity: 100,
        rotation: 0,
        scale: 100,
        position: { x: 0, y: 0 },
        speed: 1,
        volume: 100,
        locked: false,
        autoFit: true,
      };
      track.clips.push(clip);
      this.timeline.duration = Math.max(this.timeline.duration, clip.start + clip.duration);
      this.selectedClipId = id;
      return id;
    },

    /** Razor cut at the playhead: split every unlocked clip the playhead crosses. */
    splitAtPlayhead(): void {
      if (!this.timeline) return;
      const frame = Math.round(this.timeline.playhead);
      const ids: string[] = [];
      for (const track of this.timeline.tracks) {
        if (track.locked) continue;
        for (const clip of track.clips) {
          if (frame > clip.start && frame < clip.start + clip.duration) ids.push(clip.id);
        }
      }
      ids.forEach((id) => this.splitClip(id, frame));
    },

    /** Razor cut: split a clip into two at an absolute timeline frame. */
    splitClip(clipId: string, atFrame: number): void {
      const track = this.timeline?.tracks.find((t) => t.clips.some((c) => c.id === clipId));
      const clip = track?.clips.find((c) => c.id === clipId);
      if (!track || !clip) return;

      const offset = Math.round(atFrame) - clip.start; // frames into the clip
      if (offset <= 0 || offset >= clip.duration) return; // cut point isn't inside the clip

      const right: Clip = {
        ...clip,
        id: newClipId(),
        effects: clip.effects.map((e) => ({ ...e })),
        position: clip.position ? { ...clip.position } : undefined,
        start: clip.start + offset,
        duration: clip.duration - offset,
        trimIn: clip.trimIn + offset,
        trimOut: clip.trimOut,
        autoFit: false,
      };
      clip.duration = offset;
      clip.trimOut = clip.trimIn + offset;
      clip.autoFit = false;
      track.clips.push(right);
      this.selectedClipId = right.id;
    },

    /**
     * Fit a freshly-added clip (and its same-source siblings, e.g. the paired audio) to the real
     * source duration once known — capped so it never overlaps the next clip on the same lane.
     */
    fitClipToSource(clipId: string, realDurationFrames: number): void {
      if (!this.timeline) return;
      if (!Number.isFinite(realDurationFrames) || realDurationFrames <= 0) return;
      const origin = this.allClips.find((c) => c.id === clipId);
      if (!origin || !origin.autoFit) return;
      const wanted = Math.max(1, Math.round(realDurationFrames));

      for (const track of this.timeline.tracks) {
        for (const c of track.clips) {
          if (!c.autoFit || c.path !== origin.path || c.trimIn !== 0) continue;
          const nextStart = track.clips
            .filter((o) => o !== c && o.start > c.start)
            .reduce((min, o) => Math.min(min, o.start), Number.POSITIVE_INFINITY);
          const cap = Number.isFinite(nextStart) ? nextStart - c.start : Number.POSITIVE_INFINITY;
          const d = Math.max(1, Math.min(wanted, cap));
          c.duration = d;
          c.trimOut = c.trimIn + d;
          c.autoFit = false;
          this.timeline.duration = Math.max(this.timeline.duration, c.start + d);
        }
      }
    },

    /** Remove a clip from the timeline. */
    removeClip(clipId: string): void {
      if (!this.timeline) return;
      for (const track of this.timeline.tracks) {
        const idx = track.clips.findIndex((c) => c.id === clipId);
        if (idx !== -1) {
          track.clips.splice(idx, 1);
          if (this.selectedClipId === clipId) this.selectedClipId = null;
          return;
        }
      }
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

    /** Add a new empty track (for overlapping / multi-layer video or extra audio). */
    addTrack(kind: 'video' | 'audio' = 'video'): string | null {
      if (!this.timeline) return null;
      const isAudio = kind === 'audio';
      const prefix = isAudio ? 'A' : 'V';
      const sameKind = this.timeline.tracks.filter((t) => (isAudio ? t.kind === 'audio' : t.kind !== 'audio'));
      const orders = this.timeline.tracks.map((t) => t.order);
      // Video tracks stack on top (lower order); audio tracks go to the bottom (higher order).
      const order = isAudio ? Math.max(0, ...orders) + 1 : Math.min(0, ...orders) - 1;
      const id = newTrackId(prefix.toLowerCase());
      const track: Track = {
        id,
        name: `${prefix}${sameKind.length + 1}`,
        kind: isAudio ? 'audio' : 'video',
        order,
        height: isAudio ? 56 : 72,
        locked: false,
        visible: true,
        muted: false,
        solo: false,
        clips: [],
      };
      this.timeline.tracks.push(track);
      return id;
    },

    /** Remove a track (and any clips on it). */
    removeTrack(trackId: string): void {
      if (!this.timeline) return;
      const idx = this.timeline.tracks.findIndex((t) => t.id === trackId);
      if (idx === -1) return;
      const [removed] = this.timeline.tracks.splice(idx, 1);
      if (removed && this.selectedClipId && removed.clips.some((c) => c.id === this.selectedClipId)) {
        this.selectedClipId = null;
      }
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
