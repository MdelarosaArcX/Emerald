import { fetchEmeraldTimecode } from '@/services/emeraldPreview';
import { useTimelineStore } from '@/stores/timelineStore';
import { defineStore } from 'pinia';

/**
 * Follows what Emerald's TX output is actually transmitting and parks the LiveEdit timeline on it.
 *
 * The two apps already share one timebase: LiveEdit lays clips down at frames-since-local-midnight
 * (see timelineStore.appendCaptureSegment) and Emerald's /api/capture/timecode reports time-of-day
 * timecode from the master generator. So an on-air timecode converts straight into a timeline frame
 * with no session offset to reconcile — following air is a matter of reading it and moving the
 * playhead there.
 *
 * Note on Tidal Lock: it is frontend-only state inside the Emerald app (a Pinia store backed by
 * localStorage — Emerald's server.js says so explicitly at /api/logs/tidal-lock, which only writes
 * a log line), so there is nothing for LiveEdit to read across the LAN. What Tidal Lock *does* is
 * keep TX pointed at whichever session is recording, and that shows up here as
 * onAir.isTransmitting plus a moving on-air timecode. Following the transmission itself is both
 * observable and the stronger signal anyway: it stays correct when someone pushes a folder on air
 * by hand, and it can't claim air is happening when TX has actually stopped.
 */

/** Survives a refresh so an operator who left the editor following air comes back still following. */
const FOLLOW_STORAGE_KEY = 'emerald.liveEdit.followOnAir';

/** How often Emerald is asked where air is. Between polls the frame is advanced locally. */
const POLL_INTERVAL_MS = 1000;

/**
 * How far the locally-advanced frame may drift from a freshly polled one before it is snapped
 * rather than eased. A poll arriving a little late shifts the answer by a few frames and easing
 * absorbs that invisibly; a real jump (TX restarted, the operator put a different source on air)
 * has to land immediately, because a slow glide across it would show the wrong frame the whole way.
 */
const RESYNC_THRESHOLD_FRAMES = 25;

interface OnAirState {
  /** Operator's Follow On Air toggle. Polling only runs while this is on. */
  following: boolean;
  transmitting: boolean;
  /** Whether Emerald answered the last poll at all — distinguishes "off air" from "unreachable". */
  reachable: boolean;
  /** Timeline frame of the material going out right now, or null when off air. */
  currentFrame: number | null;
  /** Timeline frame the current transmission began at, or null when off air. */
  startedFrame: number | null;
  /** ISO instant TX went live, for display alongside the derived timecode. */
  startedAt: string | null;
  broadcastDelaySeconds: number;
  fps: number;
}

/** Frames since local midnight for an HH:MM:SS:FF time-of-day timecode. */
function timecodeToFrames(timecode: string, fps: number): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(timecode.trim());
  if (!match) return null;
  const [, hh, mm, ss, ff] = match.map(Number);
  return ((hh * 60 + mm) * 60 + ss) * fps + ff;
}

export const useOnAirStore = defineStore('onAir', {
  state: (): OnAirState => ({
    following: localStorage.getItem(FOLLOW_STORAGE_KEY) === '1',
    transmitting: false,
    reachable: true,
    currentFrame: null,
    startedFrame: null,
    startedAt: null,
    broadcastDelaySeconds: 0,
    fps: 25,
  }),

  getters: {
    /** True only when following AND air is actually happening — what the timeline should react to. */
    active: (state): boolean => state.following && state.transmitting && state.currentFrame !== null,
    /** How long the current transmission has been on air, in frames. */
    airedFrames: (state): number =>
      state.currentFrame !== null && state.startedFrame !== null
        ? Math.max(0, state.currentFrame - state.startedFrame)
        : 0,
  },

  actions: {
    toggleFollow(): void {
      this.setFollowing(!this.following);
    },

    setFollowing(value: boolean): void {
      this.following = value;
      localStorage.setItem(FOLLOW_STORAGE_KEY, value ? '1' : '0');

      if (value) {
        this.startPolling();
        // Don't leave the timeline sitting wherever it was until the first poll lands — an
        // operator who just engaged this is looking for air to appear now, not in a second.
        void this.poll();
      } else {
        this.stopPolling();
        this.transmitting = false;
        this.currentFrame = null;
        this.startedFrame = null;
        this.startedAt = null;
      }
    },

    /**
     * Reads Emerald's on-air state and rebases the timeline onto it.
     *
     * The start frame is derived from elapsed time rather than from converting startedAt directly:
     * startedAt and timestamp both come off the Emerald backend's clock, so subtracting them gives
     * a duration that is immune to LiveEdit's own machine being set differently. Converting
     * startedAt to a time of day here would silently bake in any offset between the two machines.
     */
    async poll(): Promise<void> {
      const status = await fetchEmeraldTimecode();

      if (!status) {
        // Emerald unreachable. The last known position is deliberately left in place rather than
        // reset — a dropped poll on a busy LAN shouldn't yank the playhead away from air.
        this.reachable = false;
        return;
      }

      this.reachable = true;
      this.fps = Math.max(1, Math.round(status.fps || 25));
      this.transmitting = status.onAir.isTransmitting;
      this.broadcastDelaySeconds = status.onAir.broadcastDelaySeconds ?? 0;
      this.startedAt = status.onAir.startedAt;

      if (!status.onAir.isTransmitting) {
        this.currentFrame = null;
        this.startedFrame = null;
        anchorFrame = null;
        return;
      }

      const frame = timecodeToFrames(status.onAir.timecode, this.fps);
      if (frame === null) return;

      if (status.onAir.startedAt) {
        const elapsedSeconds = Math.max(
          0,
          (Date.parse(status.timestamp) - Date.parse(status.onAir.startedAt)) / 1000,
        );
        if (Number.isFinite(elapsedSeconds)) {
          this.startedFrame = Math.max(0, frame - Math.round(elapsedSeconds * this.fps));
        }
      }

      // Re-anchor the local tick on this authoritative reading. Everything it produces until the
      // next poll is measured from here, so the estimate can't accumulate its own error.
      anchorFrame = frame;
      anchorAtMs = performance.now();

      this.applyFrame(frame, true);
    },

    /**
     * Move the timeline onto an on-air frame.
     *
     * `fromPoll` marks the authoritative updates. Frames produced by the local tick in between are
     * an estimate, and are never allowed to become the basis for the next resync decision.
     */
    applyFrame(frame: number, fromPoll: boolean): void {
      const timeline = useTimelineStore();
      const drift = this.currentFrame === null ? Infinity : Math.abs(frame - this.currentFrame);

      this.currentFrame = frame;

      if (!this.following) return;

      // Air is normally ahead of the last segment that finished writing, and setPlayhead clamps to
      // the timeline's duration — without this the playhead would peg to the end of the last clip
      // and stop following as soon as it caught up with the recorded material.
      timeline.ensureDuration(frame + this.fps);

      // setPlayhead's emit is suppressed: this runs up to once a frame, and air is a fact each
      // client reads from Emerald for itself, not a scrub one client should be broadcasting to
      // every other over the socket.
      timeline.setPlayhead(frame, false);

      // A jump this large isn't air advancing, it's air moving: TX restarted, or a different
      // source was pushed. The viewport has to be taken there, not left showing where air used
      // to be.
      if (fromPoll && drift > RESYNC_THRESHOLD_FRAMES) {
        timeline.pendingScrollFrame = frame;
      }
    },

    startPolling(): void {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
      startTicking(this);
    },

    stopPolling(): void {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      stopTicking();
    },
  },
});

// Module-level rather than state: these are handles to browser timers and a scratch anchor, and
// putting them in Pinia state would make them reactive (and clutter devtools) for no benefit.
let pollTimer: number | null = null;
let rafId = 0;
/** Last polled frame and the local instant it was read at — the basis for the inter-poll estimate. */
let anchorFrame: number | null = null;
let anchorAtMs = 0;

/**
 * Advances the on-air frame between polls so the timeline glides instead of stepping once a second.
 *
 * Every estimate is measured from the last poll's anchor rather than from the previous frame. A
 * per-tick delta would have to be floored to whole frames and would throw the remainder away ~60
 * times a second, running visibly behind air within a minute; measuring from a fixed anchor cannot
 * accumulate error at all, and each poll resets it.
 */
function startTicking(store: ReturnType<typeof useOnAirStore>): void {
  if (rafId) return;

  const tick = (ts: number): void => {
    rafId = requestAnimationFrame(tick);
    if (anchorFrame === null || !store.following || !store.transmitting) return;

    const estimate = anchorFrame + Math.round(((ts - anchorAtMs) / 1000) * store.fps);
    if (estimate !== store.currentFrame) store.applyFrame(estimate, false);
  };

  rafId = requestAnimationFrame(tick);
}

function stopTicking(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  anchorFrame = null;
  anchorAtMs = 0;
}
