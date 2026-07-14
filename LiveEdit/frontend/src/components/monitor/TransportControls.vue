<script setup lang="ts">
/**
 * Professional transport control bar: frame stepping, jump, play/pause/stop,
 * fullscreen, volume, and playback speed selection.
 */
import {
  ArrowsPointingOutIcon,
  BackwardIcon,
  ForwardIcon,
  PauseIcon,
  PlayIcon,
  SpeakerWaveIcon,
  StopIcon,
} from '@heroicons/vue/24/solid';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';

defineProps<{
  isPlaying: boolean;
  volume: number;
  speed: number;
  speedOptions: number[];
}>();

const emit = defineEmits<{
  play: [];
  pause: [];
  stop: [];
  prevFrame: [];
  nextFrame: [];
  jumpBack: [];
  jumpForward: [];
  fullscreen: [];
  'update:volume': [value: number];
  'update:speed': [value: number];
}>();

function onVolumeInput(event: Event): void {
  emit('update:volume', Number((event.target as HTMLInputElement).value));
}

function onSpeedChange(event: Event): void {
  emit('update:speed', Number((event.target as HTMLSelectElement).value));
}
</script>

<template>
  <div class="flex items-center justify-between gap-4 rounded-lg border border-white/5 bg-surface-850/70 px-4 py-2">
    <div class="flex items-center gap-1.5">
      <button
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-emerald-300"
        title="Jump Back 10s"
        @click="emit('jumpBack')"
      >
        <BackwardIcon class="h-4 w-4" />
      </button>
      <button
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-emerald-300"
        title="Previous Frame"
        @click="emit('prevFrame')"
      >
        <ChevronLeftIcon class="h-5 w-5" />
      </button>

      <button
        class="mx-1 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 text-surface-950 shadow-glow transition hover:brightness-110"
        :title="isPlaying ? 'Pause' : 'Play'"
        @click="isPlaying ? emit('pause') : emit('play')"
      >
        <PauseIcon v-if="isPlaying" class="h-4 w-4" />
        <PlayIcon v-else class="h-4 w-4 translate-x-[1px]" />
      </button>

      <button
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-rose-400"
        title="Stop"
        @click="emit('stop')"
      >
        <StopIcon class="h-4 w-4" />
      </button>

      <button
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-emerald-300"
        title="Next Frame"
        @click="emit('nextFrame')"
      >
        <ChevronRightIcon class="h-5 w-5" />
      </button>
      <button
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-emerald-300"
        title="Jump Forward 10s"
        @click="emit('jumpForward')"
      >
        <ForwardIcon class="h-4 w-4" />
      </button>
    </div>

    <div class="flex items-center gap-4">
      <select
        class="rounded-md border border-white/5 bg-surface-800 px-2 py-1 text-xs text-slate-300 focus:border-emerald-500/50 focus:outline-none"
        :value="speed"
        @change="onSpeedChange"
      >
        <option v-for="opt in speedOptions" :key="opt" :value="opt">{{ opt }}x</option>
      </select>

      <div class="flex items-center gap-1.5">
        <SpeakerWaveIcon class="h-4 w-4 text-slate-400" />
        <input
          type="range"
          min="0"
          max="100"
          class="h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/10 accent-emerald-400"
          :value="volume"
          @input="onVolumeInput"
        />
        <span class="w-7 font-mono text-[11px] text-slate-400">{{ volume }}</span>
      </div>

      <button
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-emerald-300"
        title="Fullscreen"
        @click="emit('fullscreen')"
      >
        <ArrowsPointingOutIcon class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>
