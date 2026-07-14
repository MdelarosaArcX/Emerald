<script setup lang="ts">
/**
 * Top application toolbar: project identity, live clock/timecode/delay,
 * connection & recording status, system metrics, and user avatar.
 */
import { useTimecode } from '@/composables/useTimecode';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import {
  BellIcon,
  CpuChipIcon,
  SignalIcon,
  WifiIcon,
} from '@heroicons/vue/24/outline';
import { useIntervalFn } from '@vueuse/core';
import { computed, ref } from 'vue';

const projectStore = useProjectStore();
const timelineStore = useTimelineStore();
const { framesToTimecode } = useTimecode();

const now = ref(new Date());
useIntervalFn(() => {
  now.value = new Date();
}, 1000);

const localTime = computed(() =>
  now.value.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
);

const timecode = computed(() => framesToTimecode(timelineStore.playhead));
const delayLabel = computed(() => `${projectStore.status.delayMs}ms`);

const networkColor = computed(() => {
  switch (projectStore.status.networkQuality) {
    case 'excellent':
      return 'text-emerald-400';
    case 'good':
      return 'text-teal-400';
    case 'poor':
      return 'text-amber-400';
    default:
      return 'text-rose-500';
  }
});
</script>

<template>
  <header
    class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/5 bg-surface-900/90 px-4 backdrop-blur-md"
  >
    <div class="flex items-center gap-3">
      <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500 shadow-glow">
        <span class="text-sm font-bold text-surface-950">E</span>
      </div>
      <div class="leading-tight">
        <p class="text-sm font-semibold tracking-wide text-slate-100">{{ projectStore.projectName }}</p>
        <p class="text-[11px] text-slate-500">Broadcast Production Suite</p>
      </div>
    </div>

    <div class="flex items-center gap-6 font-mono text-sm">
      <div class="flex flex-col items-center">
        <span class="text-[10px] uppercase tracking-widest text-slate-500">Local Time</span>
        <span class="text-slate-200">{{ localTime }}</span>
      </div>
      <div class="flex flex-col items-center rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-1 shadow-glow">
        <span class="text-[10px] uppercase tracking-widest text-emerald-400/80">Timecode</span>
        <span class="text-emerald-300">{{ timecode }}</span>
      </div>
      <div class="flex flex-col items-center">
        <span class="text-[10px] uppercase tracking-widest text-slate-500">Delay</span>
        <span class="text-slate-200">{{ delayLabel }}</span>
      </div>
    </div>

    <div class="flex items-center gap-4">
      <div class="flex items-center gap-1.5 rounded-full border border-white/5 bg-surface-800 px-2.5 py-1">
        <span
          class="h-1.5 w-1.5 rounded-full"
          :class="projectStore.status.connected ? 'bg-emerald-400 shadow-glow animate-pulseGlow' : 'bg-rose-500'"
        />
        <span class="text-xs text-slate-400">{{ projectStore.status.connected ? 'Connected' : 'Offline' }}</span>
      </div>

      <div
        v-if="projectStore.status.recording"
        class="flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/10 px-2.5 py-1"
      >
        <span class="h-1.5 w-1.5 animate-blink rounded-full bg-rose-500" />
        <span class="text-xs font-medium text-rose-400">REC</span>
      </div>

      <div class="hidden items-center gap-3 text-xs text-slate-400 lg:flex">
        <div class="flex items-center gap-1" title="CPU Usage">
          <CpuChipIcon class="h-4 w-4 text-teal-400" />
          <span>{{ Math.round(projectStore.status.cpuUsage) }}%</span>
        </div>
        <div class="flex items-center gap-1" title="Memory Usage">
          <SignalIcon class="h-4 w-4 text-teal-400" />
          <span>{{ Math.round(projectStore.status.memoryUsage) }}%</span>
        </div>
        <div class="flex items-center gap-1" title="Frame Rate">
          <span class="text-teal-400">FPS</span>
          <span>{{ projectStore.status.fps.toFixed(2) }}</span>
        </div>
        <WifiIcon class="h-4 w-4" :class="networkColor" title="Network Quality" />
      </div>

      <button class="relative rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200">
        <BellIcon class="h-5 w-5" />
        <span class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </button>

      <div class="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-emerald-600 text-xs font-semibold text-surface-950 shadow-glow-teal">
        EM
      </div>
    </div>
  </header>
</template>
