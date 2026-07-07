<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import RecorderPanel from "../components/RecorderPanel.vue";
import PreviewPlayer from "../components/PreviewPlayer.vue";
import CanvasWorkspace from "../components/CanvasWorkspace.vue";
import { useRecorderStore } from "../stores/recorder";

const recorder = useRecorderStore();
const refreshHandle = ref<number | null>(null);
const clockHandle = ref<number | null>(null);
const now = ref(Date.now());
const librarySplitView = ref(false);

const configuredFps = computed(() => Math.max(1, Number(recorder.settings.fps) || 25));

const selectedRecording = computed(() => recorder.selectedRecording);

// ProRes 422 MOV is not browser-decodable — don't pass it to the video element.
const isBrowserPlayable = (fileName: string) => !/\.mov$/i.test(fileName);

const libraryPreviewUrl = computed(() => {
  const recording = selectedRecording.value;
  if (!recording || !isBrowserPlayable(recording.fileName)) return "";
  return recording.url;
});
const libraryDescription = computed(() => {
  const recording = selectedRecording.value;
  if (recording && !isBrowserPlayable(recording.fileName)) {
    return "ProRes 422 MOV — not browser-playable. Download the file to view in a compatible player.";
  }
  return "Recorded Emerald segment from backend storage.";
});
const libraryDetail = computed(() => {
  const recording = selectedRecording.value;
  if (!recording) return "Waiting for recorded chunks";
  return `${formatSize(recording.size)} | ${formatDate(recording.createdAt)}`;
});
const captureTimecode = computed(() => formatWallClockTimecode(now.value, configuredFps.value));
const captureTransportLabel = computed(() => {
  if (recorder.isRecording) return "Recording ...";
  if (selectedRecording.value) return selectedRecording.value.fileName;
  return "Emerald Preview";
});
const captureTitle = computed(() => recorder.settings.title || "Emerald live preview");
const captureDescription = computed(() => recorder.settings.description || "The right video frame shows the stream currently being published from Emerald.");
const captureDetail = computed(() => {
  const status = recorder.recorderStatus;
  const segmentSeconds = status?.segmentSeconds || recorder.settings.segmentSeconds;
  return formatTimecode(segmentSeconds);
});
const captureFormat = computed(() => "MP4 | H.264 (playout) + MOV | ProRes 422 (archival)");
const captureFps = computed(() => `${recorder.settings.fps} FPS`);
const captureVideoBitrate = computed(() => recorder.settings.videoBitrate);
const captureAudioBitrate = computed(() => recorder.settings.audioBitrate);
const captureSampleFrequency = computed(() => recorder.settings.audioSampleFrequency);
const captureOutputPath = computed(() => recorder.recorderStatus?.outputPattern || "");
const captureFfmpegPath = computed(() => recorder.settings.ffmpegPath);

onMounted(async () => {
  recorder.loadSettings();
  await recorder.refresh();
  refreshHandle.value = window.setInterval(() => recorder.refresh(), 3000);
  clockHandle.value = window.setInterval(() => {
    now.value = Date.now();
  }, Math.round(1000 / configuredFps.value));
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

function toggleLibrarySplitView() {
  librarySplitView.value = !librarySplitView.value;
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

function formatWallClockTimecode(currentTime: number, fps: number) {
  const date = new Date(currentTime);
  const frames = Math.floor((date.getMilliseconds() / 1000) * fps);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(frames)}`;
}

function pad(value: number) {
  return String(Math.trunc(value)).padStart(2, "0");
}
</script>

<template>
  <section class="workspace-grid">
    <section class="deck media-deck" aria-label="Media browser">
      <span class="deck-tab">Media Browser</span>
      <PreviewPlayer
        :src="libraryPreviewUrl"
        :fps="configuredFps"
        variant="library"
        :title="selectedRecording?.fileName"
        :description="libraryDescription"
        :detail="libraryDetail"
        :start-at="selectedRecording?.createdAt"
        :split-view="librarySplitView"
        @toggle-split-view="toggleLibrarySplitView"
      />
      <CanvasWorkspace
        :recordings="recorder.recordings"
        :selected-file-name="recorder.selectedRecordingFileName"
        :selected-recording="selectedRecording"
        :split-view="librarySplitView"
        @select="recorder.selectRecording"
      />
    </section>

    <section class="deck capture-deck" aria-label="Capture deck">
      <span class="deck-tab">Capture Deck</span>
      <PreviewPlayer
        :src="recorder.activePreviewUrl"
        :fps="configuredFps"
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
</template>
