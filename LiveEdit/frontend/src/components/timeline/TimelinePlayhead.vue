<script setup lang="ts">
/**
 * Vertical playhead indicator overlaid on the timeline content.
 * Draggable to scrub; position is derived from the current frame.
 */
import { computed } from 'vue';

const props = defineProps<{
  frame: number;
  pixelsPerFrame: number;
}>();

const emit = defineEmits<{
  scrub: [frames: number];
}>();

const left = computed(() => props.frame * props.pixelsPerFrame);

function onPointerDown(event: PointerEvent): void {
  event.stopPropagation();
  const container = (event.currentTarget as HTMLElement).closest('[data-timeline-content]') as HTMLElement | null;
  if (!container) return;

  function move(e: PointerEvent): void {
    const rect = container!.getBoundingClientRect();
    const x = e.clientX - rect.left + container!.scrollLeft;
    emit('scrub', Math.max(0, Math.round(x / props.pixelsPerFrame)));
  }
  function up(): void {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
</script>

<template>
  <div class="pointer-events-none absolute inset-y-0 z-30" :style="{ left: `${left}px` }">
    <div
      class="pointer-events-auto absolute -top-1 -translate-x-1/2 cursor-ew-resize"
      @pointerdown="onPointerDown"
    >
      <div class="h-2.5 w-3.5 rounded-sm bg-emerald-400 shadow-glow" style="clip-path: polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)" />
    </div>
    <div class="h-full w-px bg-emerald-400 shadow-glow" />
  </div>
</template>
