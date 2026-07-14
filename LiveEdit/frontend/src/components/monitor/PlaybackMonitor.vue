<script setup lang="ts">
/**
 * Right panel: Live Playback monitor showing the currently playing
 * clip's preview and file metadata.
 */
import { usePlaybackStore } from '@/stores/playbackStore';
import { PlayCircleIcon, PauseCircleIcon } from '@heroicons/vue/24/solid';
import { FilmIcon } from '@heroicons/vue/24/outline';
import { computed } from 'vue';

const playbackStore = usePlaybackStore();
const info = computed(() => playbackStore.info);

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
</script>

<template>
  <section class="flex h-full flex-col gap-3 rounded-xl border border-white/5 bg-surface-900/80 p-3 shadow-panel">
    <header class="flex items-center justify-between">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Live Playback</h2>
      <component
        :is="info.isPlaying ? PlayCircleIcon : PauseCircleIcon"
        class="h-4 w-4"
        :class="info.isPlaying ? 'text-emerald-400' : 'text-slate-600'"
      />
    </header>

    <div class="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-white/5 bg-black">
      <div class="absolute inset-0 bg-grid-fade" />
      <FilmIcon class="h-10 w-10 text-slate-700" />
      <div
        v-if="info.isPlaying"
        class="absolute left-2 top-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 backdrop-blur"
      >
        <span class="h-2 w-2 rounded-full bg-emerald-400 shadow-glow animate-pulseGlow" />
        <span class="font-mono text-[11px] text-emerald-300">PLAYING</span>
      </div>
    </div>

    <div class="flex-1 space-y-2 overflow-y-auto rounded-lg border border-white/5 bg-surface-850/60 p-3 text-xs">
      <h3 class="mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Clip Metadata</h3>
      <dl class="space-y-1.5">
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">File Path</dt>
          <dd class="truncate font-mono text-slate-300" :title="info.filePath">{{ info.filePath || '—' }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Duration</dt>
          <dd class="font-mono text-slate-300">{{ formatDuration(info.duration) }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">FPS</dt>
          <dd class="font-mono text-slate-300">{{ info.fps }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Resolution</dt>
          <dd class="font-mono text-slate-300">{{ info.resolution }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Codec</dt>
          <dd class="font-mono text-slate-300">{{ info.codec }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Audio Channels</dt>
          <dd class="font-mono text-slate-300">{{ info.audioChannels }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>
