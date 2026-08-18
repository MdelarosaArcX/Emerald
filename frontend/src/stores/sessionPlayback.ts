import { defineStore } from "pinia";
import { useTxStore } from "./tx";

export type SessionSummary = {
  folder: string;
  createdAt: string;
  segmentCount: number;
  size: number;
  isActive: boolean;
};

export type CuedClip = {
  folder: string;
  fileName: string;
  thumbnailUrl: string;
};

// Survives a page refresh so the operator doesn't lose their selected recording folder
// (and, with it, Push On Air / playback context) every time the page reloads.
const SELECTED_FOLDER_STORAGE_KEY = "emerald.sessionPlayback.selectedFolder";
// Tidal Lock lives on the store (not component state) so it stays engaged across page
// navigation — SessionPlaybackDeck may unmount when you switch pages, but this Pinia store is
// an app-wide singleton that doesn't. Persisted too, so a page refresh doesn't silently turn it
// off (and desync the UI from TX, which keeps transmitting regardless of what the frontend
// thinks) either.
const TIDAL_LOCK_STORAGE_KEY = "emerald.sessionPlayback.tidalLockEnabled";

/**
 * The recorder settings that decide when a new recording first has something airable, read live
 * from /api/obs-recording/status rather than assumed. These defaults only stand in before the
 * first poll answers (and match the recorder store's own defaults — 2 minutes and 1 minute).
 */
const DEFAULT_SEGMENT_SECONDS = 120;
const DEFAULT_BROADCAST_DELAY_SECONDS = 60;

/** The recorder fields Playback needs. A focused read of the same status the Capture page shows. */
type RecorderSnapshot = {
  isRecording: boolean;
  startedAt: string | null;
  segmentSeconds: number;
  broadcastDelaySeconds: number;
};

export const useSessionPlaybackStore = defineStore("sessionPlayback", {
  state: () => ({
    sessions: [] as SessionSummary[],
    selectedFolder: localStorage.getItem(SELECTED_FOLDER_STORAGE_KEY) || "",
    recorder: null as RecorderSnapshot | null,
    // How far this browser's clock sits from the backend's. startedAt below is stamped on the
    // backend's clock, so without correcting for this a workstation whose time is a minute off
    // would hold TX a minute too long — or, worse, release it a minute early. Fed in by
    // SessionPlaybackDeck, which already measures it on its /api/capture/timecode poll.
    clockOffsetMs: 0,
    // "On air" is a single staged clip ("Put on Air" in the Media Browser), not a rundown —
    // staging a new one replaces whatever was previously staged. Set directly from whatever
    // clip is selected in the Media Browser (a different store/data source), not looked up
    // from a Playback-owned list.
    cuedClip: null as CuedClip | null,
    tidalLockEnabled: localStorage.getItem(TIDAL_LOCK_STORAGE_KEY) === "1",
    tidalLockedFolder: null as string | null,
    isBusy: false,
    message: "",
  }),
  getters: {
    /**
     * The instant the current recording first has something that can legally go to air.
     *
     * Two waits stack, and both have to pass. ffmpeg only closes a segment every `segmentSeconds`,
     * so until then nothing on disk is a complete file. Then the live TX playlist withholds each
     * finished segment until it is `broadcastDelaySeconds` old — the deliberate gap that gives a
     * producer a window to catch something before it airs. At the recorder's defaults that is
     * 2 minutes then 1 minute: TX has nothing airable until 3 minutes in.
     *
     * Null when nothing is recording — a finished session's segments are all long past both waits,
     * so there is nothing to hold for.
     */
    onAirReadyAtMs(state): number | null {
      const recorder = state.recorder;
      if (!recorder?.isRecording || !recorder.startedAt) return null;

      const startedAtMs = Date.parse(recorder.startedAt);
      if (!Number.isFinite(startedAtMs)) return null;

      const segmentSeconds = recorder.segmentSeconds || DEFAULT_SEGMENT_SECONDS;
      const delaySeconds = recorder.broadcastDelaySeconds ?? DEFAULT_BROADCAST_DELAY_SECONDS;
      return startedAtMs + (segmentSeconds + delaySeconds) * 1000;
    },
    /** Total hold, in seconds — what the countdown counts down from. */
    onAirHoldSeconds(state): number {
      const recorder = state.recorder;
      return (recorder?.segmentSeconds || DEFAULT_SEGMENT_SECONDS)
        + (recorder?.broadcastDelaySeconds ?? DEFAULT_BROADCAST_DELAY_SECONDS);
    },
  },
  actions: {
    /** Backend-corrected "now" — see clockOffsetMs. */
    backendNowMs(): number {
      return Date.now() + this.clockOffsetMs;
    },
    setClockOffsetMs(offsetMs: number) {
      if (Number.isFinite(offsetMs)) this.clockOffsetMs = offsetMs;
    },
    async loadRecorderStatus() {
      try {
        this.recorder = await api<RecorderSnapshot>("/api/obs-recording/status");
      } catch {
        // Transient — hold on to the last known status rather than dropping to defaults, which
        // would restart the countdown from a start time we no longer know.
      }
    },
    async loadSessions() {
      this.sessions = await api<SessionSummary[]>("/api/recording-sessions");

      if (this.selectedFolder && !this.sessions.some((session) => session.folder === this.selectedFolder)) {
        this.selectedFolder = "";
        localStorage.removeItem(SELECTED_FOLDER_STORAGE_KEY);
      }
    },
    selectFolder(folder: string) {
      if (!folder || folder === this.selectedFolder) return;

      this.selectedFolder = folder;
      this.message = "";
      localStorage.setItem(SELECTED_FOLDER_STORAGE_KEY, folder);
    },
    // "Put on Air" — stages a clip for transmission without starting TX yet.
    cueClip(clip: CuedClip) {
      this.cuedClip = clip;
    },
    clearCue() {
      this.cuedClip = null;
    },
    toggleTidalLock() {
      this.tidalLockEnabled = !this.tidalLockEnabled;
      localStorage.setItem(TIDAL_LOCK_STORAGE_KEY, this.tidalLockEnabled ? "1" : "0");
      logTidalLockChange(this.tidalLockEnabled);

      if (this.tidalLockEnabled) {
        this.applyTidalLock();
      } else {
        this.tidalLockedFolder = null;
      }
    },
    // Tidal Lock: once engaged, keeps TX permanently pointed at whatever recording is
    // currently active — no manual folder pick or Push On Air needed. Callers re-run this on
    // every status poll so it follows a recording as it starts, switches to a new one once the
    // old one finishes and a new session starts recording, and takes TX off air automatically
    // once nothing is recording.
    async applyTidalLock() {
      const tx = useTxStore();
      if (!this.tidalLockEnabled || tx.isBusy) return;

      const active = this.sessions.find((session) => session.isActive);

      if (!active) {
        this.tidalLockedFolder = null;
        if (tx.isTransmitting) {
          await tx.stop();
        }
        return;
      }

      if (this.selectedFolder !== active.folder) {
        this.selectFolder(active.folder);
      }

      // TX might already be correctly on air for this exact folder — either because we started
      // it ourselves earlier (tidalLockedFolder already matches), or because Tidal Lock just
      // re-engaged after a page refresh and TX (a separate always-running hardware process)
      // never actually stopped. tidalLockedFolder itself isn't persisted across a refresh, so
      // without the sourceUrl check below every refresh would otherwise stop and immediately
      // restart an already-correct feed, causing a needless on-air blip.
      if (tx.isTransmitting && (this.tidalLockedFolder === active.folder || tx.status?.sourceUrl?.includes(active.folder))) {
        this.tidalLockedFolder = active.folder;
        return;
      }

      // Hold until the recording has a finished segment that has also cleared the broadcast delay
      // (see onAirReadyAtMs). Starting earlier fails anyway — /api/tx/start rejects with "TX
      // playlist isn't ready yet" while no segment has aged in — but that turns every 5s poll into
      // a failed start and an error message, and the moment one *does* appear TX would go live on
      // a segment that hasn't served its delay. Waiting deliberately is the difference between
      // being early and being wrong.
      //
      // Any previous transmission is deliberately left running through the hold rather than
      // stopped first: taking air to black for three minutes because a new recording started is
      // worse than briefly staying on the old source.
      const readyAtMs = this.onAirReadyAtMs;
      if (readyAtMs !== null && this.backendNowMs() < readyAtMs) return;

      if (tx.isTransmitting) {
        await tx.stop();
      }

      this.tidalLockedFolder = active.folder;
      await tx.start(active.folder);
    },
  },
});

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || "Request failed.");
  }

  return result as T;
}

// Best-effort — a failed log call shouldn't block engaging/disengaging Tidal Lock itself.
function logTidalLockChange(engaged: boolean): void {
  fetch("/api/logs/tidal-lock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engaged }),
  }).catch(() => {});
}
