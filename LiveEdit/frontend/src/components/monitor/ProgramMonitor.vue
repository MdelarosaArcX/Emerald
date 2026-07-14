<script setup lang="ts">
/**
 * Center panel: the Program Monitor. Large timecode readout, a
 * Video.js-backed preview surface, and the professional transport bar.
 */
import AudioMeter from '@/components/monitor/AudioMeter.vue';
import TransportControls from '@/components/monitor/TransportControls.vue';
import { useTimecode } from '@/composables/useTimecode';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import 'video.js/dist/video-js.css';
import videojs from 'video.js';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const timelineStore = useTimelineStore();
const playbackStore = usePlaybackStore();
const { framesToTimecode } = useTimecode(timelineStore.fps);

const videoRef = ref<HTMLVideoElement | null>(null);
let player: ReturnType<typeof videojs> | null = null;

onMounted(() => {
  if (!videoRef.value) return;
  player = videojs(videoRef.value, {
    controls: false,
    autoplay: false,
    fluid: false,
    responsive: true,
    bigPlayButton: false,
  });
});

onBeforeUnmount(() => {
  player?.dispose();
});

const timecode = computed(() => framesToTimecode(timelineStore.playhead));

function stepFrame(delta: number): void {
  timelineStore.setPlayhead(timelineStore.playhead + delta);
}

function jumpSeconds(seconds: number): void {
  timelineStore.setPlayhead(timelineStore.playhead + seconds * timelineStore.fps);
}

function handleFullscreen(): void {
  player?.requestFullscreen();
}
</script>

<template>
  <section class="flex h-full flex-col gap-3 rounded-xl border border-white/5 bg-surface-900/80 p-3 shadow-panel">
    <header class="flex items-center justify-between">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Program Monitor</h2>
      <div
        class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-1 font-mono text-lg tracking-wider text-emerald-300 shadow-glow"
      >
        {{ timecode }}
      </div>
      <span class="text-[10px] uppercase tracking-widest text-slate-500">{{ timelineStore.fps.toFixed(2) }} fps</span>
    </header>

    <div class="relative flex flex-1 items-center gap-3 overflow-hidden rounded-lg border border-white/5 bg-black">
      <div class="relative flex h-full flex-1 items-center justify-center">
        <video ref="videoRef" class="video-js h-full w-full" playsinline />
        <div class="pointer-events-none absolute inset-0 bg-grid-fade" />
      </div>
      <div class="flex h-full w-8 shrink-0 items-center justify-center border-l border-white/5 bg-surface-900/60 py-3">
        <AudioMeter :level="playbackStore.info.isPlaying ? playbackStore.info.volume : 0" />
      </div>
    </div>

    <TransportControls
      :is-playing="playbackStore.info.isPlaying"
      :volume="playbackStore.info.volume"
      :speed="playbackStore.info.speed"
      :speed-options="playbackStore.playbackRateOptions"
      @play="playbackStore.play()"
      @pause="playbackStore.pause()"
      @stop="playbackStore.stop()"
      @prev-frame="stepFrame(-1)"
      @next-frame="stepFrame(1)"
      @jump-back="jumpSeconds(-10)"
      @jump-forward="jumpSeconds(10)"
      @fullscreen="handleFullscreen"
      @update:volume="playbackStore.setVolume($event)"
      @update:speed="playbackStore.setSpeed($event)"
    />
  </section>
</template>

<style scoped>
:deep(.video-js) {
  background-color: transparent;
}
</style>
