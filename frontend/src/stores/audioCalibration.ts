import { defineStore } from "pinia";

// Operator lip-sync calibration: how far audio is shifted relative to video, in milliseconds.
// Positive delays audio, negative advances it. The value itself lives in DeltacastCaptureService
// (the only place that can actually apply it, since it owns the ffmpeg legs that take video and
// audio separately) — this store is just the UI's view of it.
export const useAudioCalibrationStore = defineStore("audioCalibration", {
  // Unbounded in both directions: no fixed range is right for every signal chain, and the
  // operator watching the preview is a better judge than a constant here.
  state: () => ({
    offsetMs: 0,
    // False when DeltacastCaptureService is unreachable — the control disables itself rather than
    // pretending an adjustment took effect.
    available: false,
    saving: false,
    error: null as string | null,
  }),
  getters: {
    // The same shift expressed in frames, which is how an operator judging lip sync against a
    // picture actually thinks about it. Fractional on purpose: sub-frame corrections are real and
    // rounding the display to whole frames would make the ms field look broken.
    offsetFrames: (state) => (fps: number) => state.offsetMs / (1000 / Math.max(1, fps)),
  },
  actions: {
    async refresh() {
      try {
        const response = await fetch("/api/audio-calibration");
        if (!response.ok) throw new Error("unavailable");
        const result = await response.json();
        // Don't clobber a value the operator is mid-way through nudging — a poll landing between
        // a keypress and its debounced POST would otherwise snap the field back.
        if (!this.saving) this.offsetMs = result.offsetMs ?? 0;
        this.available = true;
        this.error = null;
      } catch {
        this.available = false;
      }
    },

    // Updates the displayed value immediately and pushes it after a short pause. The pause
    // matters: every accepted change restarts the preview encoder, so sending one per keystroke
    // (or per repeat while a step button is held) would leave the preview permanently mid-restart
    // and never actually show the operator the result they're tuning for.
    set(offsetMs: number) {
      if (!Number.isFinite(offsetMs)) return;
      // Rounded to 1/100th of a millisecond only to keep the field from accumulating float noise
      // as frame steps are added up — not a range limit.
      const value = Math.round(offsetMs * 100) / 100;
      this.offsetMs = value;
      this.saving = true;

      if (pushHandle !== null) window.clearTimeout(pushHandle);
      pushHandle = window.setTimeout(() => this.push(value), PUSH_DEBOUNCE_MS);
    },

    async push(offsetMs: number) {
      try {
        const response = await fetch("/api/audio-calibration", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offsetMs }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Unable to set audio calibration.");

        // Take the server's value back so the field always shows what the ffmpeg legs are
        // actually using, rather than what was typed.
        this.offsetMs = result.offsetMs;
        this.available = true;
        this.error = null;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },
  },
});

// Long enough to cover the gap between deliberate nudges — someone stepping a frame at a time,
// or typing a three-digit value, produces a change every few hundred ms, and 300ms was short
// enough that most of them got through as separate changes. Each one restarts the preview
// encoder, so a burst of them left the preview permanently mid-restart: the operator saw a
// stuttering picture and had nothing stable to judge sync against, which defeats the point of
// tuning live. Waiting for the operator to actually settle costs a moment of delay and buys one
// clean restart instead of seven.
const PUSH_DEBOUNCE_MS = 800;
let pushHandle: number | null = null;
