import { defineStore } from "pinia";

type CaptureTimecode = {
  timecode: string;
  timestamp: string;
  fps: number;
  capture: {
    isCapturing: boolean;
    startedAt: string | null;
    framesReceived: number;
    framesDropped: number;
    lastFrameAt: string | null;
    delaySeconds: number | null;
    channelIndex: number | null;
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
  },
  actions: {
    async refresh() {
      try {
        this.data = await api<CaptureTimecode>("/api/capture/timecode");
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
