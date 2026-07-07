<script setup lang="ts">
import { computed } from "vue";
import { useRecorderStore } from "./stores/recorder";
import { useBroadcastStore } from "./stores/broadcast";

const recorder = useRecorderStore();
const broadcast = useBroadcastStore();

const statusLabel = computed(() => {
  if (recorder.isRecording) return "Recording";
  if (broadcast.isBroadcasting) return "Live";
  if (recorder.webrtcStatus?.isRunning) return "Previewing";
  return "Idle";
});

const isLive = computed(() => recorder.isRecording || broadcast.isBroadcasting);
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <a class="brand" href="/">Emerald Capture</a>
      <nav class="primary-nav" aria-label="Primary">
        <router-link to="/">Capture</router-link>
        <router-link to="/playback">Playback</router-link>
        <a href="/">History</a>
        <a href="/">Settings</a>
      </nav>
      <div class="top-actions" aria-label="Status">
        <span class="signal-icon" aria-hidden="true"></span>
        <span class="user-icon" aria-hidden="true"></span>
        <span class="status-pill" :class="{ live: isLive }">{{ statusLabel }}</span>
      </div>
    </header>

    <router-view />
  </main>
</template>
