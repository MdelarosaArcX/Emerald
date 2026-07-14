<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useRecorderStore } from "./stores/recorder";
import { useBroadcastStore } from "./stores/broadcast";

const route = useRoute();
const recorder = useRecorderStore();
const broadcast = useBroadcastStore();

const statusLabel = computed(() => {
  if (recorder.isRecording) return "Recording";
  if (broadcast.isBroadcasting) return "Live";
  if (recorder.webrtcStatus?.isRunning) return "Previewing";
  return "Idle";
});

const isLive = computed(() => recorder.isRecording || broadcast.isBroadcasting);
const chromeless = computed(() => Boolean(route.meta.chromeless));
</script>

<template>
  <main v-if="chromeless" class="chromeless-shell">
    <router-view />
  </main>
  <main v-else class="app-shell">
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

<style>
.chromeless-shell {
  width: 100vw;
  height: 100vh;
  margin: 0;
  padding: 0;
}
</style>
