<script setup lang="ts">
/**
 * Left panel: live capture source preview, capture metadata,
 * and ingest control buttons (import / record / capture / snapshot / refresh).
 */
import { useCaptureStore } from '@/stores/captureStore';
import { useWhepPreview } from '@/composables/useWhepPreview';
import { fetchCapturePreviewWhepUrl } from '@/services/emeraldPreview';
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  CameraIcon,
  FilmIcon,
  StopCircleIcon,
  VideoCameraIcon,
} from '@heroicons/vue/24/outline';
import { computed, onMounted } from 'vue';

const captureStore = useCaptureStore();
const info = computed(() => captureStore.info);

// Live video/audio from the main Emerald backend's own capture preview (RX3-sourced) — separate
// from captureStore, which only tracks this app's own mock recording metadata/state.
// useWhepPreview() tears itself down on unmount, no need to do it again here.
const { videoRef, connected: previewConnected, audioDetected, connect } = useWhepPreview();

onMounted(async () => {
  const whepUrl = await fetchCapturePreviewWhepUrl();
  if (whepUrl) connect(whepUrl);
});

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function handleRecordToggle(): Promise<void> {
  if (info.value.isCapturing) {
    await captureStore.stopCapture();
  } else {
    await captureStore.startCapture();
  }
}
</script>

<template>
  <section class="flex h-full flex-col gap-3 rounded-xl border border-white/5 bg-surface-900/80 p-3 shadow-panel">
    <header class="flex items-center justify-between">
      <h2 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-slate-400">
        <VideoCameraIcon class="h-4 w-4 text-teal-400" />
        Capture Preview
      </h2>
      <span
        class="rounded-full px-2 py-0.5 text-[10px] font-medium"
        :class="info.isCapturing ? 'bg-rose-500/15 text-rose-400' : 'bg-white/5 text-slate-500'"
      >
        {{ info.isCapturing ? 'CAPTURING' : 'IDLE' }}
      </span>
    </header>

    <div class="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-white/5 bg-black">
      <div v-if="!previewConnected" class="absolute inset-0 bg-grid-fade" />
      <FilmIcon v-if="!previewConnected" class="h-10 w-10 text-slate-700" />
      <video ref="videoRef" class="h-full w-full object-contain" autoplay muted playsinline />
      <div
        v-if="previewConnected"
        class="absolute left-2 top-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 backdrop-blur"
      >
        <span class="h-2 w-2 animate-blink rounded-full bg-rose-500" />
        <span class="font-mono text-[11px] text-rose-400">LIVE</span>
      </div>
      <div
        v-if="previewConnected"
        class="absolute left-2 bottom-2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 backdrop-blur"
        :title="audioDetected ? 'Receiving audio' : 'No audio detected'"
      >
        <span class="h-1.5 w-1.5 rounded-full" :class="audioDetected ? 'bg-emerald-400' : 'bg-slate-600'" />
        <span class="font-mono text-[10px]" :class="audioDetected ? 'text-emerald-300' : 'text-slate-500'">
          {{ audioDetected ? 'AUDIO' : 'NO AUDIO' }}
        </span>
      </div>
      <div class="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
        {{ info.resolution }}
      </div>
    </div>

    <div class="grid grid-cols-2 gap-1.5">
      <button
        class="flex items-center justify-center gap-1.5 rounded-lg border border-white/5 bg-surface-800 py-1.5 text-xs text-slate-300 transition hover:border-teal-500/40 hover:text-teal-300"
      >
        <ArrowUpTrayIcon class="h-3.5 w-3.5" />
        Import
      </button>
      <button
        class="flex items-center justify-center gap-1.5 rounded-lg border py-1.5 text-xs transition"
        :class="
          info.isCapturing
            ? 'border-rose-500/40 bg-rose-500/10 text-rose-400 shadow-glow'
            : 'border-white/5 bg-surface-800 text-slate-300 hover:border-rose-500/40 hover:text-rose-400'
        "
        @click="handleRecordToggle"
      >
        <StopCircleIcon v-if="info.isCapturing" class="h-3.5 w-3.5" />
        <span v-else class="h-2.5 w-2.5 rounded-full bg-current" />
        {{ info.isCapturing ? 'Stop' : 'Record' }}
      </button>
      <button
        class="flex items-center justify-center gap-1.5 rounded-lg border border-white/5 bg-surface-800 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500/40 hover:text-emerald-300"
      >
        <VideoCameraIcon class="h-3.5 w-3.5" />
        Capture
      </button>
      <button
        class="flex items-center justify-center gap-1.5 rounded-lg border border-white/5 bg-surface-800 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500/40 hover:text-emerald-300"
      >
        <CameraIcon class="h-3.5 w-3.5" />
        Snapshot
      </button>
      <button
        class="col-span-2 flex items-center justify-center gap-1.5 rounded-lg border border-white/5 bg-surface-800 py-1.5 text-xs text-slate-300 transition hover:border-teal-500/40 hover:text-teal-300"
      >
        <ArrowPathIcon class="h-3.5 w-3.5" />
        Refresh
      </button>
    </div>

    <div class="flex-1 space-y-2 overflow-y-auto rounded-lg border border-white/5 bg-surface-850/60 p-3 text-xs">
      <h3 class="mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Capture Information</h3>
      <dl class="space-y-1.5">
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Local Path</dt>
          <dd class="truncate font-mono text-slate-300" :title="info.localPath">{{ info.localPath }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Title</dt>
          <dd class="truncate text-slate-300">{{ info.title }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Description</dt>
          <dd class="truncate text-slate-300" :title="info.description">{{ info.description }}</dd>
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
          <dt class="text-slate-500">Bitrate</dt>
          <dd class="font-mono text-slate-300">{{ info.bitrate }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>
