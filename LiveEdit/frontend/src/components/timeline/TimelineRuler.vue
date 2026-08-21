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
  /** Strip height in pixels — see TimelineEditor's RULER_HEIGHT_PX for why it is passed in. */
  height: number;
  /** Horizontal scroll window in content pixels — only this range is drawn (see `ticks`). */
  viewportStartPx: number;
  viewportEndPx: number;
}>();

/**
 * How far past each edge of the viewport ticks are still drawn, so scrolling reveals ruler that is
 * already there rather than ticks popping in at the edge.
 */
const OVERSCAN_PX = 600;

/**
 * Width to draw before the viewport has been measured (first paint, or a container that reports 0
 * while hidden). Enough to fill any realistic panel, and corrected the moment a scroll or resize
 * lands — without it the ruler would render empty on the very first frame.
 */
const UNMEASURED_WIDTH_PX = 2400;

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

/**
 * Ticks for the visible window only.
 *
 * Frame 0 is midnight and live material lands at its real time of day, so a timeline carrying an
 * evening recording spans ~2.1 million frames. Drawing a tick across all of it is 42,000 elements
 * at default zoom — rebuilt on every zoom change, and enough to visibly stutter the playhead-follow
 * scroll. The ruler is positioned absolutely inside the scroll content, so ticks outside the
 * viewport are invisible anyway; only the window (plus overscan) needs to exist.
 */
const ticks = computed(() => {
  const stepFrames = secondStep.value * props.fps;
  const stepPx = stepFrames * props.pixelsPerFrame;
  const contentWidth = props.durationFrames * props.pixelsPerFrame;
  if (stepPx <= 0 || contentWidth <= 0) return [];

  const measured = props.viewportEndPx > props.viewportStartPx;
  const from = Math.max(0, props.viewportStartPx - OVERSCAN_PX);
  const to = Math.min(
    contentWidth,
    (measured ? props.viewportEndPx : props.viewportStartPx + UNMEASURED_WIDTH_PX) + OVERSCAN_PX,
  );

  const result: { frame: number; label: string; left: number }[] = [];
  for (let i = Math.floor(from / stepPx); i * stepPx <= to; i += 1) {
    const frame = i * stepFrames;
    if (frame > props.durationFrames) break;
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
    class="relative shrink-0 cursor-pointer border-b border-white/10 bg-surface-850/80"
    :style="{ width: `${durationFrames * pixelsPerFrame}px`, height: `${height}px` }"
    @click="onClick"
  >
    <div
      v-for="tick in ticks"
      :key="tick.frame"
      class="absolute top-0 flex h-full items-center"
      :style="{ left: `${tick.left}px` }"
    >
      <div class="h-2 w-px bg-white/20" />
      <span class="ml-1 font-mono text-[0.625rem] text-slate-500">{{ tick.label }}</span>
    </div>
  </div>
</template>
