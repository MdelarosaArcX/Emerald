<script setup lang="ts">
/**
 * Left panel: capture source preview, capture metadata, and ingest controls
 * (import / record / capture / snapshot / refresh / fullscreen).
 *
 * The live preview embeds the main Emerald app's chromeless /monitor/capture
 * page directly — that page owns the live playback and self-heals — so this app
 * no longer negotiates its own WHEP/WebRTC session here.
 */
import { useCaptureStore } from '@/stores/captureStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useTimecode } from '@/composables/useTimecode';
import { captureMonitorUrl } from '@/services/emeraldPreview';
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  ArrowsPointingOutIcon,
  CameraIcon,
  GlobeAltIcon,
  StopIcon,
  VideoCameraIcon,
} from '@heroicons/vue/24/outline';
import { computed, ref } from 'vue';

const captureStore = useCaptureStore();
const settingsStore = useSettingsStore();
const timelineStore = useTimelineStore();
const { framesToTimecode } = useTimecode(timelineStore.fps);
const info = computed(() => captureStore.info);
const timecode = computed(() => framesToTimecode(timelineStore.playhead));

const frameRef = ref<HTMLIFrameElement | null>(null);

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

function requestFullscreen(): void {
  frameRef.value?.requestFullscreen?.();
}
</script>

<template>
  <section class="flex h-full min-w-0 flex-1 flex-col gap-2 rounded-xl border border-white/5 bg-surface-900/80 p-2.5 shadow-panel">
    <!-- Amber timecode header over the embedded capture monitor -->
    <div class="shrink-0 overflow-hidden rounded-lg border border-white/5 bg-black">
      <div class="flex items-center justify-between bg-gradient-to-r from-amber-500/80 to-amber-600/70 px-2 py-0.5">
        <span class="font-mono text-[11px] font-semibold tracking-wider text-black/90">{{ timecode }}</span>
        <span class="font-mono text-[9px] uppercase tracking-widest text-black/70">{{ info.resolution }}</span>
      </div>
      <!-- Compact fixed height in Live Edit mode (stacked column) so the details below stay
           visible; full 16:9 in the tall tabbed panel. -->
      <div class="relative overflow-hidden bg-black" :class="settingsStore.liveEditMode ? 'h-[92px]' : 'aspect-video'">
        <iframe
          ref="frameRef"
          :src="captureMonitorUrl"
          class="h-full w-full border-0"
          title="Capture preview"
          allow="autoplay; fullscreen"
        ></iframe>
      </div>
    </div>

    <!-- Transport / ingest control row -->
    <div class="flex shrink-0 items-center justify-between rounded-lg border border-white/5 bg-surface-850/70 px-2 py-1.5">
      <button
        class="rounded p-1 transition"
        :class="info.isCapturing ? 'text-rose-400 shadow-glow-rose' : 'text-slate-400 hover:text-rose-400'"
        :title="info.isCapturing ? 'Stop recording' : 'Record'"
        @click="handleRecordToggle"
      >
        <StopIcon v-if="info.isCapturing" class="h-4 w-4" />
        <span v-else class="block h-3 w-3 rounded-full bg-current" />
      </button>
      <button class="rounded p-1 text-slate-400 transition hover:text-teal-300" title="Refresh">
        <ArrowPathIcon class="h-4 w-4" />
      </button>
      <button class="rounded p-1 text-slate-400 transition hover:text-teal-300" title="Import media">
        <ArrowUpTrayIcon class="h-4 w-4" />
      </button>
      <button class="rounded p-1 text-slate-400 transition hover:text-emerald-300" title="Capture source">
        <VideoCameraIcon class="h-4 w-4" />
      </button>
      <button class="rounded p-1 text-slate-400 transition hover:text-emerald-300" title="Snapshot">
        <CameraIcon class="h-4 w-4" />
      </button>
      <span class="flex h-5 w-6 items-center justify-center rounded border border-emerald-400/40 bg-emerald-400/10 font-mono text-[9px] font-bold text-emerald-300">VU</span>
      <button class="rounded p-1 text-slate-400 transition hover:text-emerald-300" title="Fullscreen" @click="requestFullscreen">
        <ArrowsPointingOutIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- Decorative signal-level bars -->
    <div class="flex shrink-0 flex-col gap-1 px-1">
      <div class="h-1 rounded-full bg-gradient-to-r from-teal-400/70 to-teal-400/10" />
      <div class="h-1 w-4/5 rounded-full bg-gradient-to-r from-emerald-400/60 to-emerald-400/10" />
      <div class="h-1 w-2/3 rounded-full bg-gradient-to-r from-teal-400/50 to-teal-400/10" />
    </div>

    <!-- Metadata -->
    <div class="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border border-white/5 bg-surface-850/60 p-3 text-xs">
      <h3 class="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
        <GlobeAltIcon class="h-3.5 w-3.5 text-teal-400" />
        Capture Preview
        <span
          class="ml-auto rounded-full px-2 py-0.5 text-[9px] font-medium"
          :class="info.isCapturing ? 'bg-rose-500/15 text-rose-400' : 'bg-white/5 text-slate-500'"
        >
          {{ info.isCapturing ? 'CAPTURING' : 'IDLE' }}
        </span>
      </h3>
      <dl class="space-y-1.5">
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Local path</dt>
          <dd class="truncate font-mono text-slate-300" :title="info.localPath">{{ info.localPath }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Title</dt>
          <dd class="truncate text-slate-300" :title="info.title">{{ info.title }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Description</dt>
          <dd class="truncate text-right text-slate-300" :title="info.description">{{ info.description }}</dd>
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
          <dt class="text-slate-500">Format</dt>
          <dd class="font-mono text-slate-300">{{ info.codec }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Resolution</dt>
          <dd class="font-mono text-slate-300">{{ info.resolution }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-slate-500">Bitrate</dt>
          <dd class="font-mono text-slate-300">{{ info.bitrate }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>
