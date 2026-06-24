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
        <PreviewPlayer :src="recorder.activePreviewUrl" variant="library" />
        <CanvasWorkspace />
      </section>

      <section class="deck capture-deck" aria-label="Capture deck">
        <span class="deck-tab">Capture Deck</span>
        <PreviewPlayer :src="recorder.activePreviewUrl" variant="capture" />
        <RecorderPanel />
      </section>
    </section>
  </main>
</template>
