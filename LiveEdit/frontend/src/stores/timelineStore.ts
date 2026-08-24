import { api } from '@/services/api';
import { fetchActiveOrLatestSession, fetchSessionClips } from '@/services/emeraldPreview';
import { getSocket, SOCKET_EVENTS } from '@/services/socket';
import { useOnAirStore } from '@/stores/onAirStore';
import type { Clip, Timeline, Track } from '@/types/clip';
import { defineStore } from 'pinia';

/**
 * How often the live recording is re-scanned for newly finished segments.
 *
 * A backstop, not the primary path — the socket feed announces segments as they finish, and they
 * are two minutes long, so there is nothing to gain from asking often and real cost to asking too
 * often (see liveSyncInFlight).
 */
const LIVE_SYNC_INTERVAL_MS = 60000;

/** Handle for the live-sync poll. Module-level so it stays out of reactive state. */
let liveSyncTimer: number | null = null;
/**
 * Guards against overlapping syncs. Emerald's segment listing walks every file in the session
 * folder — tens of thousands of HLS chunks on a recording that has been running all day — and can
 * take longer than the poll interval. A bare interval would then start a second request before the
 * first returned, then a third, each re-walking the whole folder and making the next slower still,
 * until a client that only ever needed one answer at a time had saturated the backend.
 */
let liveSyncInFlight = false;

/**
 * Source keys of live segments the operator has removed from the timeline.
 *
 * The backfill poll re-reads the whole recording session every few seconds and has no memory of
 * what was deliberately taken off the timeline — without this, deleting a live segment (or cutting
 * one from air) would see it reappear on the very next tick. Module-level rather than in state
 * because it is bookkeeping for the sync, not something any view renders.
 */
const dismissedLiveKeys = new Set<string>();

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
  /**
   * The segment's real recorded timecode on the generator's clock, when Emerald knows it.
   * Preferred over createdAt for placement — see placeLiveSegment.
   */
  startTimecode?: string | null;
}

/**
 * Frames since midnight for an "HH:MM:SS:FF" time-of-day timecode, or null if it isn't one.
 *
 * The same conversion onAirStore does for the on-air timecode, and deliberately identical: a
 * segment placed by this and an air position derived by that have to land on the same scale or the
 * on-air marker will not sit over the material actually going out.
 */
function timecodeToFrames(timecode: string, fps: number): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(timecode.trim());
  if (!match) return null;
  const [, hh, mm, ss, ff] = match.map(Number);
  return ((hh * 60 + mm) * 60 + ss) * fps + ff;
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
    /**
     * Every live-captured clip the playhead currently sits inside — the material going to air right
     * now. Usually the segment on the live video lane plus its paired audio clip, but a split
     * segment or a second live lane is handled the same way since the flag travels with the pieces.
     */
    onAirClips(): Clip[] {
      if (!this.isPlaying) return [];
      const frame = this.playhead;
      return this.allClips.filter((c) => c.live && frame >= c.start && frame < c.start + c.duration);
    },
    /**
     * Frame span to draw the ON AIR band over, or null when nothing is on air.
     *
     * Two sources, in order of authority:
     *
     *  1. Emerald's TX output, when Follow On Air is engaged. This is air as a fact — the span runs
     *     from the timecode the transmission started at to the timecode going out right now, so the
     *     band grows across the session and shows exactly what this transmission has carried.
     *  2. Otherwise, the live-captured clips under the playhead during local playback. A local
     *     preview of live material isn't air, but it is the closest thing the editor can show when
     *     TX isn't being followed, and the band is the same shape either way.
     */
    onAirRegion(): { start: number; end: number } | null {
      const onAir = useOnAirStore();
      if (onAir.active && onAir.currentFrame !== null) {
        return { start: onAir.startedFrame ?? onAir.currentFrame, end: onAir.currentFrame };
      }

      const clips = this.onAirClips;
      if (!clips.length) return null;
      // The union rather than just the top lane's clip: an operator watching this band needs to
      // know how much runway is left before playback runs off the end of the captured material,
      // and that is the latest end across everything under the playhead, not one track's.
      return {
        start: Math.min(...clips.map((c) => c.start)),
        end: Math.max(...clips.map((c) => c.start + c.duration)),
      };
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
      const startFrame = this.placeLiveSegment({
        name: payload.fileName,
        url: payload.proxyUrl,
        durationSeconds: payload.durationSeconds,
        createdAt: payload.createdAt,
        hasAudio: payload.hasAudio,
        // Must match runLiveSync's key exactly — this payload names the segment by the LiveEdit
        // proxy it generated, the poll names it by Emerald's own URL, and folder/fileName is the
        // only thing the two have in common.
        sourceKey: `${payload.folder}/${payload.fileName}`,
        startTimecode: payload.startTimecode,
      });

      // Bring the newly-landed segment into view — see pendingScrollFrame's doc comment. Only for
      // segments arriving live: a backfill places dozens at once and the last one to land is not
      // necessarily where the operator wants to be looking.
      if (startFrame !== null) this.pendingScrollFrame = startFrame;
    },

    /**
     * Places one captured segment on the live video lane at its real time-of-day timecode, and
     * returns the frame it landed on (null if it was skipped).
     *
     * Shared by both routes material arrives on: the socket feed announcing segments as they finish,
     * and syncLiveSession's backfill of everything recorded before this browser was watching. They
     * have to agree on placement to the frame or the same segment would sit in two different places
     * depending on which route happened to deliver it.
     *
     * Already-placed segments are skipped by source URL, which is what makes the backfill safe to
     * re-run on a timer: each tick only adds what is genuinely new.
     */
    placeLiveSegment(payload: {
      name: string;
      url: string;
      durationSeconds: number;
      createdAt: string;
      hasAudio: boolean;
      thumbnail?: string;
      /** `folder/fileName` — see Clip.sourceKey. Both arrival routes must derive this the same way. */
      sourceKey?: string;
      /** The segment's recorded timecode on the generator's clock, when Emerald knows it. */
      startTimecode?: string | null;
    }): number | null {
      if (!this.timeline) {
        console.warn('Ignoring capture segment: timeline has not loaded yet.', payload);
        return null;
      }

      // Identity first, URL only as a fallback for callers that have no key. The two routes a
      // segment arrives by (socket feed and backfill poll) serve the same file from different
      // hosts under different paths, so matching on URL let every segment through twice.
      const existing = payload.sourceKey
        ? this.allClips.find((c) => c.sourceKey === payload.sourceKey)
        : this.allClips.find((c) => c.path === payload.url);

      if (existing) {
        // The socket payload has no thumbnail and the backfill does, so whichever arrives second
        // is allowed to fill in what the first could not supply. Without this, a segment announced
        // over the socket stayed a blank block for the rest of the session even though the poll
        // later learned its thumbnail.
        if (!existing.thumbnail && payload.thumbnail) {
          for (const track of this.timeline.tracks) {
            for (const clip of track.clips) {
              if (clip.sourceKey === payload.sourceKey && !clip.thumbnail && clip.type !== 'audio') {
                clip.thumbnail = payload.thumbnail;
              }
            }
          }
        }
        return null;
      }

      // A live segment the operator deliberately removed — most often by cutting it from air —
      // must not be resurrected by the next backfill poll, which has no idea it was ever there.
      if (payload.sourceKey && dismissedLiveKeys.has(payload.sourceKey)) return null;

      let track = this.videoTracks.find((t) => t.kind === 'video');
      if (!track) {
        const trackId = this.addTrack('video');
        track = this.timeline.tracks.find((t) => t.id === trackId);
      }
      if (!track) return null;

      if (track.locked) {
        console.warn('Ignoring capture segment: the live video lane is locked.', payload);
        return null;
      }

      // Position by the segment's real recorded timecode when Emerald knows it.
      //
      // The fallback below derives a position from the file's birthtime as read on *this* machine's
      // clock, which is what the timeline used to do exclusively — and it is why the timeline, the
      // playback preview and the on-air marker never quite agreed: the other two are expressed on
      // the Timecode System generator's clock, and this one was not. startTimecode is that same
      // generator clock (Emerald puts birthtime through timecodeAtLocalInstant before storing it),
      // so positioning by it puts all three on one reference.
      let timecodeFrame = payload.startTimecode
        ? timecodeToFrames(payload.startTimecode, this.fps)
        : null;

      if (timecodeFrame === null) {
        const segmentStartedAtMs = new Date(payload.createdAt).getTime();
        if (!Number.isFinite(segmentStartedAtMs)) return null;

        const dayStartMs = startOfDayMs(segmentStartedAtMs);
        timecodeFrame = Math.round(((segmentStartedAtMs - dayStartMs) / 1000) * this.fps);
      }
      // Clamp forward only — a genuine gap (dropped/delayed segment) still shows up as a gap, but
      // clock imprecision can't land this a frame or two *before* the previous clip's end and
      // overlap it. Real material does need this: consecutive segments routinely overlap by a
      // second or two, because each one's duration slightly exceeds the interval between their
      // birth times.
      const previousClipEnd = track.clips.reduce((end, c) => Math.max(end, c.start + c.duration), 0);
      const startFrame = Math.max(timecodeFrame, previousClipEnd);

      this.addClipFromSource({
        name: payload.name,
        url: payload.url,
        thumbnail: payload.thumbnail,
        durationFrames: Math.round(payload.durationSeconds * this.fps),
        trackId: track.id,
        startFrame,
        hasAudio: payload.hasAudio,
        live: true,
        sourceKey: payload.sourceKey,
      });

      return startFrame;
    },

    /**
     * Loads every finished segment of the recording currently on air onto the timeline, at its real
     * time-of-day position.
     *
     * This is what makes turning Live Edit Mode on mid-transmission work. The socket feed only
     * announces segments that finish while this browser is connected — the LiveEdit backend marks a
     * segment announced the first time it sees it, whether or not anyone was listening — so opening
     * the editor at 10:02 on a transmission that started at 10:00 would otherwise show an empty
     * timeline with the playhead parked on nothing.
     *
     * Safe to call repeatedly: placeLiveSegment skips anything already on the timeline, so running
     * this on a timer both backfills the past and keeps up with the present.
     */
    async syncLiveSession(): Promise<void> {
      if (liveSyncInFlight) return;
      liveSyncInFlight = true;
      try {
        await this.runLiveSync();
      } finally {
        liveSyncInFlight = false;
      }
    },

    /** The sync itself. Only ever entered through syncLiveSession's in-flight guard. */
    async runLiveSync(): Promise<void> {
      const session = await fetchActiveOrLatestSession();
      if (!session) return;

      const clips = await fetchSessionClips(session.folder);

      // Selection is restored afterwards: addClipFromSource selects what it inserts (right for a
      // deliberate drag-in, wrong for a bulk sync that would otherwise yank the inspector onto
      // whichever segment happened to land last).
      const previousSelection = this.selectedClipId;

      const finished = clips
        // "ts" segments are raw HLS chunks of the still-recording tail, and an mp4 without a probed
        // duration is still being written — neither is a complete file, which is what goes on the
        // timeline.
        .filter((clip) => clip.kind === 'mp4' && clip.durationSeconds != null)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

      for (const clip of finished) {
        this.placeLiveSegment({
          name: clip.fileName,
          url: clip.url,
          durationSeconds: clip.durationSeconds as number,
          createdAt: clip.createdAt,
          hasAudio: clip.hasAudio !== false,
          thumbnail: clip.thumbnailUrl ?? undefined,
          startTimecode: clip.startTimecode,
          // Same key the socket route derives — see appendCaptureSegment.
          sourceKey: `${clip.sessionFolder}/${clip.fileName}`,
        });
      }

      this.selectedClipId = previousSelection;
    },

    /**
     * Begins keeping the timeline in step with the live recording — an immediate backfill, then a
     * poll for newly finished segments.
     *
     * Polls rather than relying on the socket alone because the socket only carries what finishes
     * while connected; this is the path that survives a reload, a navigation away and back, or the
     * LiveEdit backend restarting mid-session.
     */
    startLiveSync(): void {
      void this.syncLiveSession();
      if (liveSyncTimer !== null) return;
      liveSyncTimer = window.setInterval(() => {
        void this.syncLiveSession();
      }, LIVE_SYNC_INTERVAL_MS);
    },

    stopLiveSync(): void {
      if (liveSyncTimer !== null) {
        window.clearInterval(liveSyncTimer);
        liveSyncTimer = null;
      }
    },

    selectClip(clipId: string | null): void {
      this.selectedClipId = clipId;
    },

    /**
     * Widen the timeline so it reaches at least `frames`.
     *
     * Following air needs this: TX transmits at the live edge, ahead of the last segment that has
     * finished writing to disk, so the on-air frame is routinely past timeline.duration — and
     * setPlayhead clamps. Without room to move into, the playhead would peg to the end of the last
     * landed clip and quietly stop following.
     */
    ensureDuration(frames: number): void {
      if (!this.timeline) return;
      const target = Math.ceil(frames);
      if (target > this.timeline.duration) this.timeline.duration = target;
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
          { id: 'v1', name: 'V1', kind: 'video', order: 0, height: 61, locked: false, visible: true, muted: false, solo: false, clips: [videoClip] },
          { id: 'a1', name: 'A1', kind: 'audio', order: 1, height: 48, locked: false, visible: true, muted: false, solo: false, clips: includeAudio ? [audioClip] : [] },
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
      /** Set by appendCaptureSegment for material coming off the live recorder — see Clip.live. */
      live?: boolean;
      /** Stable segment identity, carried onto the clip so both arrival routes dedupe on it. */
      sourceKey?: string;
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
        live: payload.live,
        sourceKey: payload.sourceKey,
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
          const [removed] = track.clips.splice(idx, 1);

          // Remember a removed live segment, but only once no piece of it is left: splitting a
          // segment and deleting one half is still an edit of material that belongs on the
          // timeline, and marking the whole source dismissed would stop the sync from ever
          // restoring it after a reload.
          if (removed?.sourceKey && !this.allClips.some((c) => c.sourceKey === removed.sourceKey)) {
            dismissedLiveKeys.add(removed.sourceKey);
          }

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
      if (track) track.height = Math.max(26, Math.min(160, height));
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
        height: isAudio ? 45 : 58,
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
