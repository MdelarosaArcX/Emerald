<script setup lang="ts">
/**
 * Hover cursor line showing the timecode under the pointer without moving
 * the playhead. Purely presentational and pointer-events-none so it never
 * intercepts clicks meant for clips/ruler underneath; position is driven
 * by the mouse-frame tracked at the TimelineEditor level.
 */
import { useTimecode } from '@/composables/useTimecode';
import { useTimelineStore } from '@/stores/timelineStore';
import { computed } from 'vue';

const props = defineProps<{
  pixelsPerFrame: number;
  fps: number;
}>();

const timelineStore = useTimelineStore();
const { framesToTimecode } = useTimecode(() => props.fps);

const visible = computed(() => timelineStore.mouseFrame !== null);
const left = computed(() => (timelineStore.mouseFrame ?? 0) * props.pixelsPerFrame);
const label = computed(() => framesToTimecode(timelineStore.mouseFrame ?? 0));
</script>

<template>
  <div v-if="visible" class="pointer-events-none absolute inset-y-0 z-20 w-px bg-teal-400/50" :style="{ left: `${left}px` }">
    <span
      class="absolute -top-5 left-0 -translate-x-1/2 whitespace-nowrap rounded bg-surface-800 px-1.5 py-0.5 font-mono text-[10px] text-teal-300 shadow-panel"
    >
      {{ label }}
    </span>
  </div>
</template>
