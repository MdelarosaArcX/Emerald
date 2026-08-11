<script setup lang="ts">
/**
 * Bottom-most application status bar: zoom level, current frame/timecode,
 * total duration, selected clip, and live mouse position over the timeline.
 */
import { useTimecode } from '@/composables/useTimecode';
import { useTimelineStore } from '@/stores/timelineStore';
import { computed } from 'vue';

const timelineStore = useTimelineStore();
const { framesToTimecode } = useTimecode(() => timelineStore.fps);

const currentTimecode = computed(() => framesToTimecode(timelineStore.playhead));
const totalTimecode = computed(() => framesToTimecode(timelineStore.duration));
const mouseTimecode = computed(() =>
  timelineStore.mouseFrame !== null ? framesToTimecode(timelineStore.mouseFrame) : '--:--:--:--',
);
</script>

<template>
  <footer class="flex h-7 shrink-0 items-center justify-between border-t border-white/5 bg-surface-900/90 px-4 font-mono text-[11px] text-slate-500">
    <div class="flex items-center gap-4">
      <span>Zoom <span class="text-slate-300">{{ Math.round(timelineStore.zoom * 100) }}%</span></span>
      <span>Frame <span class="text-slate-300">{{ Math.round(timelineStore.playhead) }}</span></span>
      <span>TC <span class="text-emerald-300">{{ currentTimecode }}</span></span>
      <span>Duration <span class="text-slate-300">{{ totalTimecode }}</span></span>
    </div>
    <div class="flex items-center gap-4">
      <span>
        Selected
        <span class="text-slate-300">{{ timelineStore.selectedClip?.name ?? 'None' }}</span>
      </span>
      <span>Mouse <span class="text-teal-300">{{ mouseTimecode }}</span></span>
    </div>
  </footer>
</template>
