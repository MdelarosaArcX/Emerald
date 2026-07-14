<script setup lang="ts">
/**
 * Standalone Playback route: live playback monitor paired with
 * transport controls for reviewing clips outside the full editor.
 */
import PlaybackMonitor from '@/components/monitor/PlaybackMonitor.vue';
import TransportControls from '@/components/monitor/TransportControls.vue';
import { usePlaybackStore } from '@/stores/playbackStore';
import { onMounted } from 'vue';

const playbackStore = usePlaybackStore();

onMounted(() => {
  playbackStore.subscribeToSocket();
});
</script>

<template>
  <div class="mx-auto flex h-full max-w-2xl flex-col gap-3 p-3">
    <PlaybackMonitor class="flex-1" />
    <TransportControls
      :is-playing="playbackStore.info.isPlaying"
      :volume="playbackStore.info.volume"
      :speed="playbackStore.info.speed"
      :speed-options="playbackStore.playbackRateOptions"
      @play="playbackStore.play()"
      @pause="playbackStore.pause()"
      @stop="playbackStore.stop()"
      @prev-frame="playbackStore.setCurrentTime(Math.max(0, playbackStore.info.currentTime - 1 / playbackStore.info.fps))"
      @next-frame="playbackStore.setCurrentTime(playbackStore.info.currentTime + 1 / playbackStore.info.fps)"
      @jump-back="playbackStore.setCurrentTime(Math.max(0, playbackStore.info.currentTime - 10))"
      @jump-forward="playbackStore.setCurrentTime(playbackStore.info.currentTime + 10)"
      @fullscreen="() => {}"
      @update:volume="playbackStore.setVolume($event)"
      @update:speed="playbackStore.setSpeed($event)"
    />
  </div>
</template>
