const fs = require("node:fs");
const path = require("node:path");
const { logEvent } = require("./eventLogService");

const DEFAULT_INTERVAL_MS = 1000;
// Rising/falling thresholds (not one shared cutoff) so a buffer sitting right at ~80% can't spam
// a WARN every tick as it jitters a percent above and below one fixed line.
const BUFFER_WARN_RATIO = 0.8;
const BUFFER_CLEAR_RATIO = 0.6;

// Continuously records capture (RX3) and on-air (TX) timecode/health, independent of whether
// anyone's polling /api/capture/timecode — a poll-request-driven log would be sparse/inconsistent
// (nothing logged if nobody's looking), and the whole point here is an auditable, gap-free
// record of what the timecode/delay actually was at any given moment (e.g. to look back at
// "what was the on-air delay at 3:45pm"). Appends newline-delimited JSON so it's trivial to tail
// or parse later, plus a compact one-line console summary for live viewing.
class TimecodeLogService {
  constructor(deltacastTx, timecodeMaster, options = {}) {
    this.deltacastTx = deltacastTx;
    this.timecodeMaster = timecodeMaster;
    this.intervalMs = options.intervalMs || Number(process.env.TIMECODE_LOG_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
    this.logPath = options.logPath || path.join(__dirname, "..", "logs", "timecode.log");
    this.handle = null;
    // Tracks the generator lock so losing (or regaining) it lands in the Capture Logs event log
    // as a discrete event, not just as a changed field on every one of these 1 Hz entries. A
    // recording made while the generator was down is worth being able to find afterwards.
    this.lastLockState = null;
    // State for the transition-detection watchers below — these live here (not in
    // DeltacastCaptureService) since Node already polls captureStatus() every tick and this is
    // the one place both the Capture Logs event log and that status are both in scope.
    this.wasAudioDetected = false;
    this.hasAudioEverBeenDetected = false;
    this.bufferWarnActive = false;
  }

  start() {
    if (this.handle) return;

    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    this.handle = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    this.handle.unref?.();
  }

  stop() {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  async tick() {
    // The generator's clock, so this log and /api/capture/timecode can never disagree about what
    // the timecode was at a given instant — they now read the same corrected clock.
    const now = this.timecodeMaster.currentDate();
    const [captureStatus, txStatus] = await Promise.all([
      this.deltacastTx.captureStatus().catch(() => null),
      this.deltacastTx.status().catch(() => null),
    ]);

    // Nothing running at all (DeltacastCaptureService down) — skip instead of logging a wall of
    // "everything null" entries.
    if (!captureStatus && !txStatus) return;

    if (captureStatus) {
      this.detectAudioTransition(captureStatus);
      this.detectBufferUsage(captureStatus);
    }

    const timecodeStatus = this.timecodeMaster.status;
    this.detectLockTransition(timecodeStatus);

    const delaySecondsSince = (lastFrameAt) => {
      if (!lastFrameAt) return null;
      return Math.max(0, (now.getTime() - new Date(lastFrameAt).getTime()) / 1000);
    };

    const entry = {
      timestamp: now.toISOString(),
      timecode: this.timecodeMaster.timecodeAt(now),
      // Recorded per entry so this log answers "was the timecode real at 3:45pm?", not just
      // "what did we think it was" — the whole point of a gap-free audit record.
      timecodeSource: timecodeStatus.source,
      timecodeLockState: timecodeStatus.lockState,
      timecodeOffsetMs: timecodeStatus.offsetMs,
      capture: {
        isCapturing: Boolean(captureStatus?.isCapturing),
        framesReceived: captureStatus?.framesReceived ?? 0,
        lastFrameAt: captureStatus?.lastFrameAt ?? null,
        delaySeconds: delaySecondsSince(captureStatus?.lastFrameAt),
      },
      onAir: {
        isTransmitting: Boolean(txStatus?.isTransmitting),
        framesSent: txStatus?.framesSent ?? 0,
        lastFrameAt: txStatus?.lastFrameAt ?? null,
        delaySeconds: delaySecondsSince(txStatus?.lastFrameAt),
      },
    };

    try {
      fs.appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      console.error("Unable to write timecode log:", error.message);
    }

    console.log(
      `[timecode] ${entry.timecode} (${entry.timecodeLockState}) `
      + `capture=${entry.capture.isCapturing ? `on(${entry.capture.delaySeconds?.toFixed(2)}s)` : "off"} `
      + `onAir=${entry.onAir.isTransmitting ? `on(${entry.onAir.delaySeconds?.toFixed(2)}s)` : "off"}`,
    );
  }

  detectLockTransition(timecodeStatus) {
    const state = timecodeStatus.lockState;
    if (state === this.lastLockState) return;

    // Skip the very first observation: at boot the service simply hasn't synced yet, and
    // announcing "generator lost" for a generator that was never claimed would be noise.
    if (this.lastLockState !== null) {
      if (state === "LOCKED") {
        logEvent(`Timecode generator locked (offset ${timecodeStatus.offsetMs}ms).`, "info", "Timecode");
      } else if (state === "MISMATCH") {
        logEvent(
          `Timecode generator disagrees by ${timecodeStatus.driftFrames} frames — check that both machines share a timezone.`,
          "warn",
          "Timecode",
        );
      } else {
        logEvent(`Timecode generator unreachable — falling back to local clock. ${timecodeStatus.lastError ?? ""}`.trim(), "warn", "Timecode");
      }
    }

    this.lastLockState = state;
  }

  // Only one embedded-audio stereo pair is ever wired up on the capture side (see
  // DeltacastSdkService.cs's audioChannelDetected comment) — "Stereo 1" is the real, only
  // channel this can report, not a stand-in for a per-channel list.
  detectAudioTransition(captureStatus) {
    const detected = Boolean(captureStatus.audioChannelDetected);

    if (detected && !this.wasAudioDetected) {
      logEvent(this.hasAudioEverBeenDetected ? "Stereo 1 restored." : "Stereo 1 detected.", "info", "Audio");
      this.hasAudioEverBeenDetected = true;
    } else if (!detected && this.wasAudioDetected) {
      logEvent("Stereo 1 signal lost.", "warn", "Audio");
    }

    this.wasAudioDetected = detected;
  }

  detectBufferUsage(captureStatus) {
    const capacity = captureStatus.bufferCapacity;
    if (!capacity) {
      this.bufferWarnActive = false;
      return;
    }

    const ratio = captureStatus.bufferInUse / capacity;
    const source = `DeltaRX${captureStatus.channelIndex ?? ""}`;

    if (ratio >= BUFFER_WARN_RATIO && !this.bufferWarnActive) {
      logEvent(`Video buffer usage exceeded ${Math.round(ratio * 100)}%.`, "warn", source);
      this.bufferWarnActive = true;
    } else if (ratio < BUFFER_CLEAR_RATIO) {
      this.bufferWarnActive = false;
    }
  }
}

module.exports = {
  TimecodeLogService,
};
