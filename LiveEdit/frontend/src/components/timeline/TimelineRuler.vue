<script setup lang="ts">
/**
 * Frame/time ruler shown above the timeline tracks. Draws second-based
 * gridlines with timecode labels, density-adjusted for the current zoom.
 */
import { useTimecode } from '@/composables/useTimecode';
import { computed } from 'vue';

const props = defineProps<{
  pixelsPerFrame: number;
  fps: number;
  durationFrames: number;
}>();

const emit = defineEmits<{
  scrub: [frames: number];
}>();

const { framesToTimecode } = useTimecode(() => props.fps);

const secondWidth = computed(() => props.pixelsPerFrame * props.fps);
const secondStep = computed(() => {
  if (secondWidth.value > 90) return 1;
  if (secondWidth.value > 40) return 2;
  if (secondWidth.value > 18) return 5;
  return 10;
});

const ticks = computed(() => {
  const totalSeconds = Math.ceil(props.durationFrames / props.fps);
  const result: { frame: number; label: string; left: number }[] = [];
  for (let s = 0; s <= totalSeconds; s += secondStep.value) {
    const frame = s * props.fps;
    result.push({ frame, label: framesToTimecode(frame), left: frame * props.pixelsPerFrame });
  }
  return result;
});

function onClick(event: MouseEvent): void {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const x = event.clientX - rect.left;
  emit('scrub', Math.max(0, Math.round(x / props.pixelsPerFrame)));
}
</script>

<template>
  <div
    class="relative h-7 shrink-0 cursor-pointer border-b border-white/10 bg-surface-850/80"
    :style="{ width: `${durationFrames * pixelsPerFrame}px` }"
    @click="onClick"
  >
    <div
      v-for="tick in ticks"
      :key="tick.frame"
      class="absolute top-0 flex h-full items-center"
      :style="{ left: `${tick.left}px` }"
    >
      <div class="h-2 w-px bg-white/20" />
      <span class="ml-1 font-mono text-[10px] text-slate-500">{{ tick.label }}</span>
    </div>
  </div>
</template>
