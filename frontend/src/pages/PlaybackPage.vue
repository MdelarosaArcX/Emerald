<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import PreviewPlayer from "../components/PreviewPlayer.vue";
import CanvasWorkspace from "../components/CanvasWorkspace.vue";
import SessionPlaybackDeck from "../components/SessionPlaybackDeck.vue";
import { useRecorderStore } from "../stores/recorder";
import { useSessionPlaybackStore } from "../stores/sessionPlayback";

const recorder = useRecorderStore();
const sessionPlayback = useSessionPlaybackStore();
const refreshHandle = ref<number | null>(null);
const librarySplitView = ref(false);

const selectedRecording = computed(() => recorder.selectedRecording);

// ProRes 422 MOV is not browser-decodable — don't pass it to the video element. Push On Air
// is also mp4-only server-side (the archival ProRes files aren't valid TX sources), so the
// same check gates both.
const isBrowserPlayable = (fileName: string) => !/\.mov$/i.test(fileName);
const canPutSelectedOnAir = computed(() => {
  const recording = selectedRecording.value;
  return Boolean(recording && isBrowserPlayable(recording.fileName));
});

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

onMounted(async () => {
  recorder.loadSettings();
  await recorder.refresh();
  refreshHandle.value = window.setInterval(() => recorder.refresh(), 3000);
});

onUnmounted(() => {
  if (refreshHandle.value) {
    window.clearInterval(refreshHandle.value);
  }
});

function toggleLibrarySplitView() {
  librarySplitView.value = !librarySplitView.value;
}

function putSelectedRecordingOnAir() {
  const recording = selectedRecording.value;
  if (!recording || !isBrowserPlayable(recording.fileName)) return;

  sessionPlayback.cueClip({
    folder: recording.sessionFolder,
    fileName: recording.fileName,
    thumbnailUrl: recording.thumbnailUrl,
  });
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
</script>

<template>
  <section class="workspace-grid">
    <section class="deck media-deck" aria-label="Media browser">
      <span class="deck-tab">Media Browser</span>
      <PreviewPlayer
        :src="libraryPreviewUrl"
        variant="library"
        :title="selectedRecording?.fileName"
        :description="libraryDescription"
        :detail="libraryDetail"
        :start-at="selectedRecording?.createdAt"
        :split-view="librarySplitView"
        :show-put-on-air="true"
        :can-put-on-air="canPutSelectedOnAir"
        @toggle-split-view="toggleLibrarySplitView"
        @put-on-air="putSelectedRecordingOnAir"
      />
      <CanvasWorkspace
        :recordings="recorder.recordings"
        :selected-file-name="recorder.selectedRecordingFileName"
        :selected-recording="selectedRecording"
        :split-view="librarySplitView"
        @select="recorder.selectRecording"
      />
    </section>

    <section class="deck capture-deck" aria-label="Playback deck">
      <span class="deck-tab">Playback Deck</span>
      <SessionPlaybackDeck />
    </section>
  </section>
</template>
