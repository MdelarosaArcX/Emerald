<script setup lang="ts">
/**
 * Right panel: Live Playback monitor showing the on-air preview and the
 * currently playing clip's file metadata.
 *
 * The on-air preview embeds the main Emerald app's chromeless /monitor/onair
 * page directly — that page owns the live playback and self-heals — so this app
 * no longer negotiates its own WHEP/WebRTC session here.
 */
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useTimecode } from '@/composables/useTimecode';
import { onAirMonitorUrl } from '@/services/emeraldPreview';
import {
  ArrowPathIcon,
  ArrowsPointingOutIcon,
  GlobeAltIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/vue/24/outline';
import { computed, ref } from 'vue';

defineProps<{ inspectorOpen?: boolean }>();
const emit = defineEmits<{ toggleInspector: [] }>();

const playbackStore = usePlaybackStore();
const timelineStore = useTimelineStore();
const { framesToTimecode } = useTimecode(() => timelineStore.fps);
const info = computed(() => playbackStore.info);
const timecode = computed(() => framesToTimecode(timelineStore.playhead));

const frameRef = ref<HTMLIFrameElement | null>(null);

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function togglePlay(): void {
  if (info.value.isPlaying) playbackStore.pause();
  else playbackStore.play();
}

function requestFullscreen(): void {
  frameRef.value?.requestFullscreen?.();
}
</script>

<template>
  <div class="flex h-full">
    <section class="flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-white/5 bg-surface-900/80 p-2.5 shadow-panel">
      <!-- Red timecode header over the embedded on-air monitor -->
      <div class="overflow-hidden rounded-lg border border-white/5 bg-black">
        <div class="flex items-center justify-between bg-gradient-to-r from-rose-600/80 to-rose-700/70 px-2 py-0.5">
          <span class="font-mono text-[0.6875rem] font-semibold tracking-wider text-white/95">{{ timecode }}</span>
          <span class="font-mono text-[0.5625rem] uppercase tracking-widest text-white/70">{{ info.resolution }}</span>
        </div>
        <div class="relative aspect-video overflow-hidden bg-black">
          <iframe
            ref="frameRef"
            :src="onAirMonitorUrl"
            class="h-full w-full border-0"
            title="On-air preview"
            allow="autoplay; fullscreen"
          ></iframe>
        </div>
      </div>

      <!-- Transport row -->
      <div class="flex items-center justify-between rounded-lg border border-white/5 bg-surface-850/70 px-2 py-1.5">
        <button
          class="rounded p-1 transition"
          :class="info.isPlaying ? 'text-emerald-300' : 'text-slate-400 hover:text-emerald-300'"
          :title="info.isPlaying ? 'Pause' : 'Play'"
          @click="togglePlay"
        >
          <PauseIcon v-if="info.isPlaying" class="h-4 w-4" />
          <PlayIcon v-else class="h-4 w-4" />
        </button>
        <button class="rounded p-1 text-slate-400 transition hover:text-rose-400" title="Stop" @click="playbackStore.stop()">
          <StopIcon class="h-4 w-4" />
        </button>
        <button class="rounded p-1 text-slate-400 transition hover:text-teal-300" title="Reload preview" @click="frameRef?.contentWindow?.location.reload()">
          <ArrowPathIcon class="h-4 w-4" />
        </button>
        <span class="flex h-5 w-6 items-center justify-center rounded border border-emerald-400/40 bg-emerald-400/10 font-mono text-[0.5625rem] font-bold text-emerald-300">VU</span>
        <button class="rounded p-1 text-slate-400 transition hover:text-emerald-300" title="Fullscreen" @click="requestFullscreen">
          <ArrowsPointingOutIcon class="h-4 w-4" />
        </button>
      </div>

      <!-- Decorative signal-level bars -->
      <div class="flex flex-col gap-1 px-1">
        <div class="h-1 rounded-full bg-gradient-to-r from-emerald-400/70 to-emerald-400/10" />
        <div class="h-1 w-4/5 rounded-full bg-gradient-to-r from-teal-400/60 to-teal-400/10" />
        <div class="h-1 w-2/3 rounded-full bg-gradient-to-r from-emerald-400/50 to-emerald-400/10" />
      </div>

      <!-- Metadata -->
      <div class="flex-1 space-y-2 overflow-y-auto rounded-lg border border-white/5 bg-surface-850/60 p-3 text-xs">
        <h3 class="mb-1 flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-widest text-slate-400">
          <GlobeAltIcon class="h-3.5 w-3.5 text-teal-400" />
          Live Playback
          <span
            class="ml-auto rounded-full px-2 py-0.5 text-[0.5625rem] font-medium"
            :class="info.isPlaying ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-slate-500'"
          >
            {{ info.isPlaying ? 'PLAYING' : 'PAUSED' }}
          </span>
        </h3>
        <dl class="space-y-1.5">
          <div class="flex justify-between gap-2">
            <dt class="text-slate-500">Local path</dt>
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
            <dt class="text-slate-500">Format</dt>
            <dd class="font-mono text-slate-300">{{ info.codec }}</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-slate-500">Resolution</dt>
            <dd class="font-mono text-slate-300">{{ info.resolution }}</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-slate-500">Audio Channels</dt>
            <dd class="font-mono text-slate-300">{{ info.audioChannels }}</dd>
          </div>
        </dl>
      </div>
    </section>

    <!-- Rotated edge tabs (right) -->
    <div class="flex w-8 shrink-0 flex-col items-stretch gap-2 pl-1">
      <div
        class="flex flex-1 items-center justify-center rounded-r-md border-r-2 border-rose-400 bg-rose-400/10 text-[0.6875rem] font-semibold uppercase tracking-widest text-rose-300"
        style="writing-mode: vertical-rl"
      >
        Live Playback
      </div>
      <button
        class="flex flex-1 items-center justify-center rounded-r-md border-r-2 text-[0.6875rem] font-semibold uppercase tracking-widest transition"
        :class="inspectorOpen ? 'border-teal-400 bg-teal-400/10 text-teal-300' : 'border-white/10 bg-white/5 text-slate-500 hover:text-slate-300'"
        style="writing-mode: vertical-rl"
        title="Toggle Video / Audio FX inspector"
        @click="emit('toggleInspector')"
      >
        Video Audio FX
      </button>
    </div>
  </div>
</template>
