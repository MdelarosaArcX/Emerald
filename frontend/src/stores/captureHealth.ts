import { defineStore } from "pinia";

// Where the timecode above came from. LOCKED means it is the Timecode System generator's;
// FREE_RUN means the generator was unreachable and the backend's own clock is standing in;
// MISMATCH means the generator answered but disagrees with us by more than a frame, which in
// practice means the two machines' clocks are in different timezones. Surfaced in the UI so an
// operator can tell a real timecode from a fallback at a glance rather than trusting all three
// equally. See Emerald/backend/services/timecodeMasterService.js.
type TimecodeSource = {
  source: "master" | "wallclock";
  lockState: "LOCKED" | "FREE_RUN" | "MISMATCH";
  masterUrl: string;
  frameRate: number;
  timecodeType: string | null;
  offsetMs: number;
  latencyMs: number | null;
  driftFrames: number | null;
  connectedReaders: number | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

type CaptureTimecode = {
  timecode: string;
  timestamp: string;
  fps: number;
  timecodeSource: TimecodeSource;
  capture: {
    isCapturing: boolean;
    startedAt: string | null;
    framesReceived: number;
    framesDropped: number;
    lastFrameAt: string | null;
    delaySeconds: number | null;
    channelIndex: number | null;
    // Set only when capture is not running — e.g. waiting for SDI signal lock on the configured
    // RX channel. See DeltacastSdkService's CaptureStatus.LastMessage.
    lastMessage: string | null;
    sdiInterface: string | null;
    videoStandard: string | null;
    videoWidth: number | null;
    videoHeight: number | null;
    videoFrameRate: number | null;
    videoBitrateKbps: number | null;
    audioBitrateKbps: number | null;
    audioChannelDetected: boolean;
    audioCapturedMs: number;
    bufferInUse: number | null;
    bufferCapacity: number | null;
  };
  onAir: {
    isTransmitting: boolean;
    timecode: string;
    broadcastDelaySeconds: number;
  };
};

export const useCaptureHealthStore = defineStore("captureHealth", {
  state: () => ({
    data: null as CaptureTimecode | null,
    // Milliseconds to add to this browser's clock to land on the backend's generator-corrected
    // clock. The timecode readout has to tick smoothly at frame rate, which a 1Hz poll can't do —
    // so instead of displaying the polled string directly, the page runs its own ticker and this
    // offset steers it onto the generator's time. It also absorbs the browser's own clock error,
    // which matters because the Capture page is routinely opened from another machine on the LAN.
    clockOffsetMs: 0,
  }),
  getters: {
    channelLabel: (state) => (state.data?.capture.channelIndex != null ? `RX${state.data.capture.channelIndex}` : "--"),
    videoFormatLabel: (state) => {
      const capture = state.data?.capture;
      if (!capture?.videoStandard) return null;
      const dimensions = capture.videoWidth && capture.videoHeight ? ` (${capture.videoWidth}x${capture.videoHeight})` : "";
      return `${capture.videoStandard}${dimensions}`;
    },
    // Encode targets FfmpegStreamingService actually runs with — not a live-measured throughput
    // (see DeltacastSdkService.cs's VideoBitrateKbps/AudioBitrateKbps comments).
    videoDataRateLabel: (state) => (state.data?.capture.videoBitrateKbps != null ? `${(state.data.capture.videoBitrateKbps / 1000).toFixed(1)} Mbps` : "--"),
    audioDataRateLabel: (state) => (state.data?.capture.audioBitrateKbps != null ? `${state.data.capture.audioBitrateKbps} kbps` : "No audio"),
    timecodeLockState: (state) => state.data?.timecodeSource?.lockState ?? null,
    timecodeIsLocked: (state) => state.data?.timecodeSource?.lockState === "LOCKED",
    // Hover text for the badge — the detail an operator needs when the badge isn't green, without
    // spending panel space on it when everything is fine.
    timecodeLockDetail: (state) => {
      const source = state.data?.timecodeSource;
      if (!source) return "";
      if (source.lockState === "LOCKED") {
        return `Locked to ${source.masterUrl} — ${source.frameRate}fps ${source.timecodeType ?? ""}, offset ${source.offsetMs}ms, latency ${source.latencyMs ?? "--"}ms`.trim();
      }
      if (source.lockState === "MISMATCH") {
        return `Generator at ${source.masterUrl} disagrees by ${source.driftFrames} frames — check both machines share a timezone.`;
      }
      return `Generator at ${source.masterUrl} unreachable — showing this machine's clock. ${source.lastError ?? ""}`.trim();
    },
  },
  actions: {
    async refresh() {
      try {
        const sentAt = Date.now();
        const data = await api<CaptureTimecode>("/api/capture/timecode");
        const receivedAt = Date.now();

        this.data = data;

        // `timestamp` is the instant the backend read its corrected clock, which happened
        // somewhere inside this request — assume the midpoint, the same symmetric-delay
        // assumption the backend itself uses against the generator.
        const backendNow = Date.parse(data.timestamp);
        if (Number.isFinite(backendNow)) {
          this.clockOffsetMs = backendNow - (sentAt + (receivedAt - sentAt) / 2);
        }
      } catch {
        // DeltacastCaptureService may not be running — a failed poll shouldn't break the page.
      }
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
