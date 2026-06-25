<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import RecorderPanel from "./components/RecorderPanel.vue";
import PreviewPlayer from "./components/PreviewPlayer.vue";
import CanvasWorkspace from "./components/CanvasWorkspace.vue";
import { useRecorderStore } from "./stores/recorder";

const recorder = useRecorderStore();
const refreshHandle = ref<number | null>(null);
const clockHandle = ref<number | null>(null);
const now = ref(Date.now());

const statusLabel = computed(() => {
  if (recorder.isRecording) return "Recording";
  if (recorder.previewStatus?.isRunning) return "Previewing";
  return "Idle";
});

const selectedRecording = computed(() => recorder.selectedRecording);
const libraryPreviewUrl = computed(() => selectedRecording.value?.url || "");
const libraryDetail = computed(() => {
  const recording = selectedRecording.value;
  if (!recording) return "Waiting for recorded chunks";
  return `${formatSize(recording.size)} | ${formatDate(recording.createdAt)}`;
});
const captureTimecode = computed(() => {
  if (recorder.recorderStatus?.isRecording && recorder.recorderStatus.startedAt) {
    return formatElapsedTimecode(recorder.recorderStatus.startedAt, now.value);
  }

  if (selectedRecording.value) {
    return formatTimecode(recorder.recorderStatus?.segmentSeconds || recorder.settings.segmentSeconds);
  }

  return "00:00:00:00";
});
const captureTransportLabel = computed(() => {
  if (recorder.isRecording) return "Recording ...";
  if (selectedRecording.value) return selectedRecording.value.fileName;
  return "OBS Preview";
});
const captureTitle = computed(() => recorder.settings.title || "OBS live preview");
const captureDescription = computed(() => recorder.settings.description || "The right video frame shows the stream currently being published from OBS.");
const captureDetail = computed(() => {
  const status = recorder.recorderStatus;
  const segmentSeconds = status?.segmentSeconds || recorder.settings.segmentSeconds;
  return formatTimecode(segmentSeconds);
});
const captureFormat = computed(() => {
  const container = recorder.recorderStatus?.container?.toUpperCase() || recorder.settings.container.toUpperCase();
  return `${container} | ${recorder.settings.videoCodec} | ${recorder.settings.audioCodec}`;
});
const captureFps = computed(() => `${recorder.settings.fps} FPS`);
const captureVideoBitrate = computed(() => recorder.settings.videoBitrate);
const captureAudioBitrate = computed(() => recorder.settings.audioBitrate);
const captureSampleFrequency = computed(() => recorder.settings.audioSampleFrequency);
const captureOutputPath = computed(() => recorder.settings.outputPath);
const captureFfmpegPath = computed(() => recorder.settings.ffmpegPath);

onMounted(async () => {
  recorder.loadSettings();
  await recorder.refresh();
  refreshHandle.value = window.setInterval(() => recorder.refresh(), 3000);
  clockHandle.value = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (refreshHandle.value) {
    window.clearInterval(refreshHandle.value);
  }
  if (clockHandle.value) {
    window.clearInterval(clockHandle.value);
  }
});

async function startCapture() {
  now.value = Date.now();
  await recorder.start();
  now.value = Date.now();
}

async function stopCapture() {
  await recorder.stop();
  now.value = Date.now();
}

function configureCaptureSource() {
  document.querySelector(".recording-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function formatSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function formatTimecode(totalSeconds: number) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(remainder)}:00`;
}

function formatElapsedTimecode(startedAt: string, currentTime = Date.now()) {
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return "00:00:00:00";

  const elapsed = Math.max(0, Math.floor((currentTime - started.getTime()) / 1000));
  return formatTimecode(elapsed);
}

function pad(value: number) {
  return String(Math.trunc(value)).padStart(2, "0");
}
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <a class="brand" href="/">Emerald IP</a>
      <nav class="primary-nav" aria-label="Primary">
        <a class="active" href="/">Monitoring</a>
        <a href="/">Broadcast</a>
        <a href="/">History</a>
        <a href="/">Settings</a>
      </nav>
      <div class="top-actions" aria-label="Status">
        <span class="signal-icon" aria-hidden="true"></span>
        <span class="user-icon" aria-hidden="true"></span>
        <span class="status-pill" :class="{ live: recorder.isRecording }">{{ statusLabel }}</span>
      </div>
    </header>

    <section class="workspace-grid">
      <section class="deck media-deck" aria-label="Media browser">
        <span class="deck-tab">Media Browser</span>
        <PreviewPlayer
          :src="libraryPreviewUrl"
          variant="library"
          :title="selectedRecording?.fileName"
          description="Recorded OBS segment from backend storage."
          :detail="libraryDetail"
        />
        <CanvasWorkspace
          :recordings="recorder.recordings"
          :selected-file-name="recorder.selectedRecordingFileName"
          @select="recorder.selectRecording"
        />
      </section>

      <section class="deck capture-deck" aria-label="Capture deck">
        <span class="deck-tab">Capture Deck</span>
        <PreviewPlayer
          :src="recorder.activePreviewUrl"
          variant="capture"
          :title="captureTitle"
          :description="captureDescription"
          :source-url="recorder.settings.inputUrl"
          :output-path="captureOutputPath"
          :detail="captureDetail"
          :duration-label="captureDetail"
          :fps-label="captureFps"
          :timecode="captureTimecode"
          :transport-label="captureTransportLabel"
          :format-label="captureFormat"
          :video-bitrate-label="captureVideoBitrate"
          :audio-bitrate-label="captureAudioBitrate"
          :sample-frequency-label="captureSampleFrequency"
          :ffmpeg-path="captureFfmpegPath"
          :is-recording="recorder.isRecording"
          :is-busy="recorder.isBusy"
          @start="startCapture"
          @stop="stopCapture"
          @configure="configureCaptureSource"
        />
        <RecorderPanel />
      </section>
    </section>
  </main>
</template>
