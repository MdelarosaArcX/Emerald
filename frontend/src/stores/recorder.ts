import { defineStore } from "pinia";

type RecorderStatus = {
  isRecording: boolean;
  startedAt: string | null;
  inputUrl: string | null;
  outputPattern: string | null;
  segmentSeconds: number;
  container: string;
  lastMessage: string | null;
};

type PreviewStatus = {
  isRunning: boolean;
  startedAt: string | null;
  previewUrl: string;
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
  url: string;
  thumbnailUrl: string;
  size: number;
  createdAt: string;
};

type RecorderSettings = {
  inputUrl: string;
  outputPath: string;
  title: string;
  description: string;
  fps: string;
  container: string;
  segmentSeconds: number;
  videoCodec: string;
  audioCodec: string;
  videoBitrate: string;
  audioBitrate: string;
  audioSampleFrequency: string;
  ffmpegPath: string;
};

const defaultSettings: RecorderSettings = {
  inputUrl: "udp://0.0.0.0:5000",
  outputPath: "recordings/obs",
  title: "Deltacast live preview",
  description: "UDP input recording from the Deltacast bridge.",
  fps: "25",
  container: "mp4",
  segmentSeconds: 120,
  videoCodec: "H.264",
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
    previewStatus: null as PreviewStatus | null,
    ingestStatus: null as IngestStatus | null,
    recordings: [] as RecordingSegment[],
    selectedRecordingFileName: "",
    message: "",
    isBusy: false,
  }),
  getters: {
    isRecording: (state) => Boolean(state.recorderStatus?.isRecording),
    activePreviewUrl: (state) => state.previewStatus?.previewUrl || "/hls/obs-preview/index.m3u8",
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
      } catch {
        localStorage.removeItem("emerald.streaming.settings");
      }
    },
    saveSettings() {
      localStorage.setItem("emerald.streaming.settings", JSON.stringify(this.settings));
    },
    async refresh() {
      const [recording, preview, ingest, recordings] = await Promise.all([
        api<RecorderStatus>("/api/obs-recording/status"),
        api<PreviewStatus>("/api/obs-preview/status"),
        api<IngestStatus>("/api/rtmp-ingest/status"),
        api<RecordingSegment[]>("/api/obs-recordings"),
      ]);

      this.recorderStatus = recording;
      this.previewStatus = preview;
      this.ingestStatus = ingest;
      this.recordings = recordings;
      if (!this.selectedRecordingFileName && recordings.length) {
        this.selectedRecordingFileName = recordings[0].fileName;
      }
      if (this.selectedRecordingFileName && !recordings.some((item) => item.fileName === this.selectedRecordingFileName)) {
        this.selectedRecordingFileName = recordings[0]?.fileName || "";
      }
      this.message = recording.lastMessage || preview.lastMessage || ingest.lastMessage || "";
    },
    selectRecording(fileName: string) {
      this.selectedRecordingFileName = fileName;
    },
    async start() {
      this.isBusy = true;
      this.saveSettings();

      try {
        this.previewStatus = await api<PreviewStatus>("/api/obs-preview/start", {
          method: "POST",
          body: this.settings,
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
        this.previewStatus = await api<PreviewStatus>("/api/obs-preview/stop", { method: "POST" });
        this.message = "Recorder stopped.";
      } finally {
        this.isBusy = false;
        await this.refresh();
      }
    },
  },
});

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
