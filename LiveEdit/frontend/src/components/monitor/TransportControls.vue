<script setup lang="ts">
/**
 * Professional transport control bar: frame stepping, jump, play/pause/stop,
 * fullscreen, volume, and playback speed selection. Restyled to the flat,
 * evenly-spaced Emerald Live Edit transport; all emits are unchanged.
 */
import {
  ArrowsPointingOutIcon,
  BackwardIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ForwardIcon,
  PauseIcon,
  PlayIcon,
  SpeakerWaveIcon,
  StopIcon,
} from '@heroicons/vue/24/solid';

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
  <div class="relative flex items-center rounded-lg border border-white/5 bg-surface-850/70 px-4 py-2">
    <!-- Centered primary transport -->
    <div class="mx-auto flex items-center gap-5">
      <button
        class="text-slate-300 transition hover:text-emerald-300"
        :title="isPlaying ? 'Pause' : 'Play'"
        @click="isPlaying ? emit('pause') : emit('play')"
      >
        <PauseIcon v-if="isPlaying" class="h-6 w-6" />
        <PlayIcon v-else class="h-6 w-6" />
      </button>
      <button class="text-slate-300 transition hover:text-rose-400" title="Stop" @click="emit('stop')">
        <StopIcon class="h-6 w-6" />
      </button>
      <button class="text-slate-300 transition hover:text-emerald-300" title="Jump back 10s" @click="emit('jumpBack')">
        <BackwardIcon class="h-6 w-6" />
      </button>
      <button class="text-slate-400 transition hover:text-emerald-300" title="Previous frame" @click="emit('prevFrame')">
        <ChevronLeftIcon class="h-5 w-5" />
      </button>
      <button class="text-slate-400 transition hover:text-emerald-300" title="Next frame" @click="emit('nextFrame')">
        <ChevronRightIcon class="h-5 w-5" />
      </button>
      <button class="text-slate-300 transition hover:text-emerald-300" title="Jump forward 10s" @click="emit('jumpForward')">
        <ForwardIcon class="h-6 w-6" />
      </button>
      <span class="flex h-7 w-7 items-center justify-center rounded-full border border-emerald-400/50 bg-emerald-400/10 font-mono text-[0.625rem] font-bold text-emerald-300" title="Audio levels">
        VU
      </span>
      <button class="text-slate-300 transition hover:text-emerald-300" title="Fullscreen" @click="emit('fullscreen')">
        <ArrowsPointingOutIcon class="h-6 w-6" />
      </button>
    </div>

    <!-- Right cluster: speed + volume -->
    <div class="absolute right-4 flex items-center gap-3">
      <select
        class="rounded-md border border-white/5 bg-surface-800 px-2 py-1 text-xs text-slate-300 focus:border-emerald-500/50 focus:outline-none"
        :value="speed"
        title="Playback speed"
        @change="onSpeedChange"
      >
        <option v-for="opt in speedOptions" :key="opt" :value="opt">{{ opt }}x</option>
      </select>
      <div class="hidden items-center gap-1.5 lg:flex">
        <SpeakerWaveIcon class="h-4 w-4 text-slate-400" />
        <input
          type="range"
          min="0"
          max="100"
          class="h-1 w-16 cursor-pointer appearance-none rounded-full bg-white/10 accent-emerald-400"
          :value="volume"
          title="Volume"
          @input="onVolumeInput"
        />
      </div>
    </div>
  </div>
</template>
