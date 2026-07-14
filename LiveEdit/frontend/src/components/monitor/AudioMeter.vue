<script setup lang="ts">
/**
 * Vertical stereo VU-style audio meter. Level is driven externally
 * (e.g. from playback volume) rather than reading real audio data,
 * since FFmpeg/audio analysis is out of scope for this phase.
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    level?: number; // 0-100
    channels?: number;
  }>(),
  { level: 0, channels: 2 },
);

const segments = 20;

function segmentColor(index: number): string {
  const ratio = index / segments;
  if (ratio > 0.9) return 'bg-rose-500';
  if (ratio > 0.75) return 'bg-amber-400';
  return 'bg-emerald-400';
}

const activeSegments = computed(() => Math.round((props.level / 100) * segments));
</script>

<template>
  <div class="flex h-full items-end gap-1">
    <div v-for="ch in channels" :key="ch" class="flex h-full w-2 flex-col-reverse gap-[2px]">
      <div
        v-for="i in segments"
        :key="i"
        class="w-full flex-1 rounded-[1px] transition-opacity"
        :class="[i <= activeSegments ? segmentColor(i) : 'bg-white/5', i <= activeSegments ? 'opacity-100' : 'opacity-40']"
      />
    </div>
  </div>
</template>
