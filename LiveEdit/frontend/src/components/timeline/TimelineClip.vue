<script setup lang="ts">
/**
 * A single draggable/resizable/selectable clip block rendered on a
 * timeline track. Position and width are derived from frame values
 * multiplied by the current pixels-per-frame scale.
 */
import { useDragResize } from '@/composables/useDragResize';
import type { Clip } from '@/types/clip';
import { computed } from 'vue';

const props = defineProps<{
  clip: Clip;
  pixelsPerFrame: number;
  selected: boolean;
  trackLocked: boolean;
  trackHeight: number;
}>();

const emit = defineEmits<{
  select: [clipId: string];
  change: [payload: { start: number; duration: number }];
  commit: [payload: { start: number; duration: number }];
}>();

const left = computed(() => props.clip.start * props.pixelsPerFrame);
const width = computed(() => Math.max(4, props.clip.duration * props.pixelsPerFrame));

const { begin } = useDragResize({
  pixelsPerFrame: () => props.pixelsPerFrame,
  minDurationFrames: 4,
  onChange: (next) => emit('change', next),
  onCommit: (next) => emit('commit', next),
});

function onPointerDown(event: PointerEvent, mode: 'move' | 'resize-left' | 'resize-right'): void {
  if (props.trackLocked) return;
  event.stopPropagation();
  emit('select', props.clip.id);
  begin(event, mode, { start: props.clip.start, duration: props.clip.duration });
}

const typeLabel = computed(() => props.clip.type.toUpperCase());
</script>

<template>
  <div
    class="group absolute top-1 flex select-none flex-col overflow-hidden rounded-md border transition-shadow"
    :style="{
      left: `${left}px`,
      width: `${width}px`,
      height: `${trackHeight - 8}px`,
      backgroundColor: `${clip.color}26`,
      borderColor: selected ? clip.color : `${clip.color}66`,
    }"
    :class="[trackLocked ? 'cursor-not-allowed opacity-60' : 'cursor-grab active:cursor-grabbing']"
    @pointerdown="onPointerDown($event, 'move')"
  >
    <div
      class="pointer-events-none absolute inset-0"
      :style="selected ? { boxShadow: `0 0 0 1.5px ${clip.color}, 0 0 16px ${clip.color}88` } : {}"
    />
    <div class="flex items-center gap-1 px-1.5 pt-1 text-[10px] font-medium leading-none" :style="{ color: clip.color }">
      <span class="truncate">{{ clip.name }}</span>
    </div>
    <span class="absolute bottom-1 left-1.5 text-[9px] uppercase tracking-wider text-slate-500">{{ typeLabel }}</span>

    <div
      v-if="!trackLocked"
      class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100"
      :style="{ backgroundColor: clip.color }"
      @pointerdown="onPointerDown($event, 'resize-left')"
    />
    <div
      v-if="!trackLocked"
      class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100"
      :style="{ backgroundColor: clip.color }"
      @pointerdown="onPointerDown($event, 'resize-right')"
    />
  </div>
</template>
