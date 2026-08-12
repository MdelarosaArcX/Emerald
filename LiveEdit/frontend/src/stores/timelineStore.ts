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
  /** Whether the Program monitor is actively advancing the playhead right now (vs. paused/scrubbing). */
  isPlaying: boolean;
  /**
   * Set whenever a live-captured segment lands on V4 — TimelineEditor.vue watches this and
   * scrolls its viewport to bring that frame into view, then clears it. Frame 0 is midnight, so
   * without this the operator would otherwise have to manually scroll from 0 up to wherever
   * "now" happens to be (e.g. 21:52:00) every time they open the editor.
   */
  pendingScrollFrame: number | null;
}

/** Payload emitted by the LiveEdit backend when an edit-capture segment finishes writing. */
export interface EditCaptureSegmentAddedPayload {
  folder: string;
  index: number;
  fileName: string;
  proxyUrl: string;
  durationSeconds: number;
  hasAudio: boolean;
  // The segment master file's own birthtime — its real start time, not its finish time (see
  // editCaptureService.js's startTimecode comment: derived from birthtime directly, no duration
  // subtraction, specifically because -use_wallclock_as_timestamps keeps this tracking true
  // elapsed time even under upstream frame drops).
  createdAt: string;
}

/** Frame 0 on V4 is midnight (local time) of the given moment's calendar day — see appendCaptureSegment(). */
function startOfDayMs(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// Very low floor so the whole (time-of-day, potentially all-day) timeline can be compressed to fit
// the viewport on full zoom-out — TimelineEditor computes the actual fit zoom from the viewport
// width and won't go below it, but the store must allow values this small.
const MIN_ZOOM = 0.0002;
const MAX_ZOOM = 8;

/** Unique-enough id for clips created at runtime (drag-insert, split). */
function newClipId(): string {
  return `clip-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Unique-enough id for tracks created at runtime. */
function newTrackId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
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
    isPlaying: false,
    pendingScrollFrame: null,
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
    /**
     * Emerald captures 25 fps, and this is the timebase the whole editor runs on: clip positions
     * are laid down as secondsSinceMidnight * fps, so it has to match both the material and the
     * whole-number divisor useTimecode renders with, or the time-of-day clock drifts.
     */
    fps(state): number {
      return state.timeline?.fps ?? 25;
    },
    duration(state): number {
      return state.timeline?.duration ?? 0;
    },
    /**
     * The earliest clip.start across every track, or null if the timeline is empty. Frame 0 is
     * midnight (see appendCaptureSegment), so a fresh/idle playhead sitting at 0 is normally in a
     * huge empty gap before any real content — Play uses this to jump there first instead of
     * silently doing nothing for the (possibly many real-time) hours until playback reaches it.
     */
    earliestClipFrame(): number | null {
      const starts = this.allClips.map((c) => c.start);
      return starts.length ? Math.min(...starts) : null;
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
      socket.on(SOCKET_EVENTS.EDIT_CAPTURE_SEGMENT_ADDED, (segment: EditCaptureSegmentAddedPayload) => {
        this.appendCaptureSegment(segment);
      });
    },

    setPlaying(value: boolean): void {
      this.isPlaying = value;
    },

    /**
     * Appends a just-finished edit-capture segment to the dedicated V4 track (creating one if
     * none exists yet), positioned at its real time-of-day timecode — frame 0 on V4 (and the
     * whole timeline) is midnight local time, so a segment captured at 9:30pm lands at frame
     * 21:30:00:00, matching wall-clock time directly rather than time-since-session-start. A
     * stall or dropped segment still shows up as a real gap instead of clips being silently
     * chained back-to-back regardless of when they actually happened.
     *
     * Targets the top video lane (the first non-fx video track by stacking order) so incoming live
     * segments land in one predictable lane; if there's no video track at all one is created. The
     * operator's own manual edits live on the lane(s) below it.
     */
    appendCaptureSegment(payload: EditCaptureSegmentAddedPayload): void {
      if (!this.timeline) {
        console.warn('Ignoring edit-capture segment: timeline has not loaded yet.', payload);
        return;
      }

      let track = this.videoTracks.find((t) => t.kind === 'video');
      if (!track) {
        const trackId = this.addTrack('video');
        track = this.timeline.tracks.find((t) => t.id === trackId);
      }
      if (!track) return;

      if (track.locked) {
        console.warn('Ignoring edit-capture segment: the live video lane is locked.', payload);
        return;
      }

      const segmentStartedAtMs = new Date(payload.createdAt).getTime();
      const dayStartMs = startOfDayMs(segmentStartedAtMs);
      const timecodeFrame = Math.round(((segmentStartedAtMs - dayStartMs) / 1000) * this.fps);
      // Clamp forward only — a genuine gap (dropped/delayed segment) still shows up as a gap, but
      // clock imprecision can't land this a frame or two *before* the previous clip's end and
      // overlap it.
      const previousClipEnd = track.clips.reduce((end, c) => Math.max(end, c.start + c.duration), 0);
      const startFrame = Math.max(timecodeFrame, previousClipEnd);
      const durationFrames = Math.round(payload.durationSeconds * this.fps);

      this.addClipFromSource({
        name: payload.fileName,
        url: payload.proxyUrl,
        durationFrames,
        trackId: track.id,
        startFrame,
        hasAudio: payload.hasAudio,
      });

      // Bring the newly-landed segment into view — see pendingScrollFrame's doc comment.
      this.pendingScrollFrame = startFrame;
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
    loadProgramClip(payload: { name: string; thumbnail: string; durationFrames: number; fps: number; url?: string; hasAudio?: boolean }): void {
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
      };
      const videoClip: Clip = { ...base, id: 'program-clip', name: payload.name, track: 'v1', color: '#14b8a6', type: 'video', thumbnail: payload.thumbnail };
      const includeAudio = payload.hasAudio !== false;
      const audioClip: Clip = { ...base, id: 'program-audio', name: `${payload.name} · audio`, track: 'a1', color: '#34d399', type: 'audio' };

      this.timeline = {
        id: 'program-timeline',
        fps: payload.fps,
        duration,
        playhead: 0,
        tracks: [
          { id: 'v1', name: 'V1', kind: 'video', order: 0, height: 76, locked: false, visible: true, muted: false, solo: false, clips: [videoClip] },
          { id: 'a1', name: 'A1', kind: 'audio', order: 1, height: 60, locked: false, visible: true, muted: false, solo: false, clips: includeAudio ? [audioClip] : [] },
        ],
      };
      this.selectedClipId = 'program-clip';
    },

    updateClip(clipId: string, patch: Partial<Clip>): void {
      const clip = this.allClips.find((c) => c.id === clipId);
      if (clip) Object.assign(clip, patch);
    },

    /**
     * Insert a clip (dragged from the media browser) onto a track at a given start frame. When
     * inserting a video clip onto a non-audio track and the source actually has audio (hasAudio,
     * default true — most recorded segments do), a matching audio clip is also dropped onto the
     * first unlocked audio track (creating one if none exists yet) at the same start/duration, so
     * the waveform lane appears immediately instead of only showing up once someone thinks to add
     * it manually — the same pairing loadProgramClip already does for the click-to-load path.
     */
    addClipFromSource(payload: {
      name: string;
      url: string;
      thumbnail?: string;
      durationFrames: number;
      trackId: string;
      startFrame: number;
      kind?: 'video' | 'audio';
      hasAudio?: boolean;
    }): string | null {
      const track = this.timeline?.tracks.find((t) => t.id === payload.trackId);
      if (!this.timeline || !track || track.locked) return null;

      const duration = Math.max(1, Math.round(payload.durationFrames));
      const startFrame = Math.max(0, Math.round(payload.startFrame));
      const isAudio = payload.kind === 'audio' || track.kind === 'audio';
      const id = newClipId();
      const clip: Clip = {
        id,
        name: payload.name,
        path: payload.url,
        track: payload.trackId,
        start: startFrame,
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
      };
      track.clips.push(clip);
      this.timeline.duration = Math.max(this.timeline.duration, clip.start + clip.duration);
      this.selectedClipId = id;

      if (!isAudio && payload.hasAudio !== false) {
        let audioTrack = this.timeline.tracks.find((t) => t.kind === 'audio' && !t.locked);
        if (!audioTrack) {
          const audioTrackId = this.addTrack('audio');
          audioTrack = this.timeline.tracks.find((t) => t.id === audioTrackId);
        }
        audioTrack?.clips.push({
          ...clip,
          id: newClipId(),
          name: `${payload.name} · audio`,
          track: audioTrack.id,
          color: '#34d399',
          type: 'audio',
          thumbnail: undefined,
        });
      }

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
      };
      clip.duration = offset;
      clip.trimOut = clip.trimIn + offset;
      track.clips.push(right);
      this.selectedClipId = right.id;
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
