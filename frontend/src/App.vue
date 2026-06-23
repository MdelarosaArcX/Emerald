<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import RecorderPanel from "./components/RecorderPanel.vue";
import PreviewPlayer from "./components/PreviewPlayer.vue";
import CanvasWorkspace from "./components/CanvasWorkspace.vue";
import { useRecorderStore } from "./stores/recorder";

const recorder = useRecorderStore();
const refreshHandle = ref<number | null>(null);

const statusLabel = computed(() => {
  if (recorder.isRecording) return "Recording";
  if (recorder.previewStatus?.isRunning) return "Previewing";
  return "Idle";
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
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <p>Emerald Streaming</p>
        <h1>Recorder Console</h1>
      </div>
      <span class="status-pill" :class="{ live: recorder.isRecording }">{{ statusLabel }}</span>
    </header>

    <section class="workspace-grid">
      <PreviewPlayer :src="recorder.activePreviewUrl" />
      <RecorderPanel />
    </section>

    <CanvasWorkspace />
  </main>
</template>
