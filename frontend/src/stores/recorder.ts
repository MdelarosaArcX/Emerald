import { defineStore } from "pinia";

type RecorderStatus = {
  isRecording: boolean;
  startedAt: string | null;
  inputUrl: string | null;
  outputPattern: string | null;
  // The ProRes 422 MOV archival leg's own output path — ffmpeg always writes this alongside
  // outputPattern's H.264 MP4 proxy from the same input (see obsIngestService.js's start()).
  archivalOutputPattern: string | null;
  segmentSeconds: number;
  broadcastDelaySeconds: number;
  container: string;
  lastMessage: string | null;
  // From RECORDING_SIZE_LIMIT (see obsIngestService.js/storageQuotaService.js) — 0 when unset
  // (no cap configured), null before start() has ever run.
  recordingSizeLimitBytes: number | null;
};

type WebrtcStatus = {
  isRunning: boolean;
  startedAt: string | null;
  whepUrl: string;
  lastMessage: string | null;
};

type IngestStatus = {
  isRunning: boolean;
  port: number;
  publishUrl: string;
  lastMessage: string | null;
  activeStreams: string[];
};

export type RecordingSegment = {
  fileName: string;
  sessionFolder: string;
  url: string;
  thumbnailUrl: string;
  size: number;
  createdAt: string;
};

type RecorderSettings = {
  inputUrl: string;
  title: string;
  description: string;
  fps: string;
  container: string;
  segmentSeconds: number;
  // Deliberate gap between "captured" and "eligible to go on air" (Tidal Lock / Push On Air both
  // read the live TX playlist, which withholds segments until they're this old) — e.g. so a
  // producer has a window to catch and cut something before it airs. 0 disables it.
  broadcastDelaySeconds: number;
  videoCodec: string;
  audioCodec: string;
  videoBitrate: string;
  audioBitrate: string;
  audioSampleFrequency: string;
  ffmpegPath: string;
};

const defaultSettings: RecorderSettings = {
  inputUrl: "udp://0.0.0.0:5000",
  title: "Emerald live preview",
  description: "UDP input recording from the Deltacast bridge.",
  fps: "25",
  container: "mov",
  segmentSeconds: 120,
  broadcastDelaySeconds: 60,
  videoCodec: "ProRes 422",
  audioCodec: "AAC",
  videoBitrate: "5000 kbps",
  audioBitrate: "320 kbps",
  audioSampleFrequency: "48 kHz",
  ffmpegPath: "ffmpeg",
};

export const useRecorderStore = defineStore("recorder", {
  state: () => ({
    settings: { ...defaultSettings },
    recorderStatus: null as RecorderStatus | null,
    webrtcStatus: null as WebrtcStatus | null,
    ingestStatus: null as IngestStatus | null,
    recordings: [] as RecordingSegment[],
    selectedRecordingFileName: "",
    message: "",
    isBusy: false,
  }),
  getters: {
    isRecording: (state) => Boolean(state.recorderStatus?.isRecording),
    // The backend's whepUrl is a static, unchanging string regardless of whether the preview
    // is actually running (see webrtcPreviewService.js) — gating on isRunning here makes this
    // value genuinely change between stop ("") and start (whepUrl) so PreviewPlayer's
    // `watch(() => props.src, ...)` actually re-fires and reconnects on every start, instead of
    // only ever connecting once (requiring a full page refresh to reconnect after a restart).
    activePreviewUrl: (state) => (state.webrtcStatus?.isRunning ? state.webrtcStatus.whepUrl : ""),
    selectedRecording: (state) => {
      return state.recordings.find((recording) => recording.fileName === state.selectedRecordingFileName)
        || state.recordings[0]
        || null;
    },
  },
  actions: {
    loadSettings() {
      const saved = localStorage.getItem("emerald.streaming.settings");
      if (!saved) return;

      try {
        this.settings = { ...defaultSettings, ...JSON.parse(saved) };
        if (this.settings.inputUrl === "udp://127.0.0.1:5000") {
          this.settings.inputUrl = defaultSettings.inputUrl;
        }
        // Migrate old H.264/mp4 defaults to ProRes 422/mov
        if (this.settings.videoCodec === "H.264" && this.settings.container === "mp4") {
          this.settings.videoCodec = "ProRes 422";
          this.settings.container = "mov";
        }
        // Migrate the old 5-minute segment default down to the new 2-minute default.
        if (this.settings.segmentSeconds === 300) {
          this.settings.segmentSeconds = defaultSettings.segmentSeconds;
        }
      } catch {
        localStorage.removeItem("emerald.streaming.settings");
      }
    },
    saveSettings() {
      localStorage.setItem("emerald.streaming.settings", JSON.stringify(this.settings));
    },
    async refresh() {
      const [recording, webrtc, ingest, recordings] = await Promise.all([
        api<RecorderStatus>("/api/obs-recording/status"),
        api<WebrtcStatus>("/api/webrtc-preview/status"),
        api<IngestStatus>("/api/rtmp-ingest/status"),
        api<RecordingSegment[]>("/api/obs-recordings"),
      ]);

      this.recorderStatus = recording;
      this.webrtcStatus = webrtc;
      this.ingestStatus = ingest;
      this.recordings = recordings;
      if (!this.selectedRecordingFileName && recordings.length) {
        this.selectedRecordingFileName = recordings[0].fileName;
      }
      if (this.selectedRecordingFileName && !recordings.some((item) => item.fileName === this.selectedRecordingFileName)) {
        this.selectedRecordingFileName = recordings[0]?.fileName || "";
      }
      this.message = recording.lastMessage || webrtc.lastMessage || ingest.lastMessage || "";
    },
    selectRecording(fileName: string) {
      this.selectedRecordingFileName = fileName;
    },
    async start() {
      this.isBusy = true;
      this.saveSettings();

      try {
        this.webrtcStatus = await api<WebrtcStatus>("/api/webrtc-preview/start", {
          method: "POST",
          body: {
            inputUrl: getWebrtcInputUrl(this.settings.inputUrl),
            ffmpegPath: this.settings.ffmpegPath,
          },
        });
        this.recorderStatus = await api<RecorderStatus>("/api/obs-recording/start", {
          method: "POST",
          body: this.settings,
        });
        this.message = "Preview and recording started.";
      } catch (error) {
        this.message = error instanceof Error ? error.message : "Unable to start recorder.";
      } finally {
        this.isBusy = false;
        await this.refresh();
      }
    },
    async stop() {
      this.isBusy = true;

      try {
        this.recorderStatus = await api<RecorderStatus>("/api/obs-recording/stop", { method: "POST" });
        await api("/api/webrtc-preview/stop", { method: "POST" });
        this.message = "Recorder stopped.";
      } finally {
        this.isBusy = false;
        await this.refresh();
      }
    },
  },
});

// A unicast UDP socket only delivers to one listener. DeltacastCaptureService relays the
// same H.264 stream to (recording port + 1) via Streaming:WebRtcRelayUrl in appsettings.json
// so the WebRTC publisher doesn't fight the recorder ffmpeg for port 5000.
function getWebrtcInputUrl(inputUrl: string): string {
  if (inputUrl.toLowerCase().startsWith("udp://")) {
    try {
      const parsed = new URL(inputUrl);
      parsed.port = String(Number(parsed.port || 5000) + 1);
      return parsed.toString();
    } catch {
      return inputUrl;
    }
  }

  return inputUrl;
}

async function api<T>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || "Request failed.");
  }

  return result as T;
}
