<script setup lang="ts">
/**
 * Top application toolbar: brand wordmark, live wall-clock timecode &
 * broadcast delay, on-air status, and the user avatar — matching the
 * Emerald Live Edit broadcast header.
 */
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { ComputerDesktopIcon, SignalIcon, UserCircleIcon } from '@heroicons/vue/24/outline';
import { useIntervalFn } from '@vueuse/core';
import { useRouter } from 'vue-router';
import { computed, ref } from 'vue';

const projectStore = useProjectStore();
const settingsStore = useSettingsStore();
const router = useRouter();

// Toggle Live Edit mode; make sure we're on the editor screen so the change is visible.
function toggleLiveEdit(): void {
  settingsStore.toggleLiveEditMode();
  if (settingsStore.liveEditMode && router.currentRoute.value.path !== '/editor') {
    router.push('/editor');
  }
}

const now = ref(new Date());
useIntervalFn(() => {
  now.value = new Date();
}, 40);

const fps = computed(() => Math.max(1, Math.round(projectStore.status.fps || 25)));

function pad(value: number): string {
  return String(Math.trunc(value)).padStart(2, '0');
}

/** Wall-clock time as a broadcast HH:MM:SS:FF timecode (frames from ms). */
const localTimecode = computed(() => {
  const d = now.value;
  const frames = Math.floor((d.getMilliseconds() / 1000) * fps.value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(frames)}`;
});

/** Broadcast delay as SS:FF, derived from the reported millisecond delay. */
const delayLabel = computed(() => {
  const ms = Math.max(0, projectStore.status.delayMs);
  const seconds = Math.floor(ms / 1000);
  const frames = Math.floor(((ms % 1000) / 1000) * fps.value);
  return `${pad(seconds)}:${pad(frames)}`;
});

const onAir = computed(() => projectStore.status.recording || projectStore.status.playing);
</script>

<template>
  <header
    class="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-white/5 bg-surface-900 px-6"
  >
    <!-- Brand wordmark -->
    <h1
      class="text-3xl font-semibold tracking-tight text-emerald-300"
      style="text-shadow: 0 0 16px rgba(34, 227, 154, 0.45)"
    >
      Emerald Live Edit
    </h1>

    <!-- Live clocks + status -->
    <div class="flex items-center gap-8">
      <div class="flex flex-col items-end leading-none">
        <span class="mb-1.5 text-[0.625rem] font-medium uppercase tracking-[0.18em] text-slate-500">
          Local Time HH:MM:SS:FPS
        </span>
        <span class="font-mono text-2xl font-semibold tracking-wide text-slate-100">
          {{ localTimecode }}
        </span>
      </div>
      <div class="flex flex-col items-end leading-none">
        <span class="mb-1.5 text-[0.625rem] font-medium uppercase tracking-[0.18em] text-slate-500">
          Delay SS:FPS
        </span>
        <span class="font-mono text-2xl font-semibold tracking-wide text-slate-100">
          {{ delayLabel }}
        </span>
      </div>

      <!-- Live Edit mode toggle: stacked capture+media on the left, effects panel on the right -->
      <button
        class="rounded-md p-1 transition"
        :class="settingsStore.liveEditMode
          ? 'bg-emerald-500/10 text-emerald-300 shadow-glow'
          : 'text-slate-400 hover:bg-white/5 hover:text-emerald-300'"
        :title="settingsStore.liveEditMode ? 'Live Edit mode: On' : 'Live Edit mode: Off'"
        @click="toggleLiveEdit"
      >
        <ComputerDesktopIcon class="h-7 w-7" />
      </button>

      <!-- On-air broadcast indicator -->
      <div
        class="rounded-md p-1"
        :class="onAir ? 'text-emerald-300' : 'text-slate-400'"
        :title="onAir ? 'On Air' : 'Off Air'"
      >
        <SignalIcon class="h-7 w-7" :class="onAir ? 'shadow-glow animate-pulseGlow' : ''" />
      </div>

      <button class="rounded-full text-slate-400 transition hover:text-emerald-300" title="Account">
        <UserCircleIcon class="h-8 w-8" />
      </button>
    </div>
  </header>
</template>
