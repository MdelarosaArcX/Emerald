<script setup lang="ts">
/**
 * Red ON-AIR band drawn across every track lane, marking the live-captured material that is going
 * out right now.
 *
 * Two intensities, because they answer different questions at a glance:
 *  - the whole on-air segment is tinted, showing how much captured runway is left before air runs
 *    off the end of what has been recorded;
 *  - the part already behind the playhead is tinted harder, showing what has actually aired.
 *
 * Only live-captured clips light this up (see Clip.live) — a clip an operator dragged in from the
 * browser is not on air just because the playhead is over it, and colouring it red would make the
 * one signal an operator must be able to trust at a glance meaningless.
 *
 * Sits above the clips but below the playhead and is pointer-transparent throughout: this is
 * status, and it must never be something an operator can click, drag or catch a trim handle on.
 */
import { useTimelineStore } from '@/stores/timelineStore';
import { computed } from 'vue';

const props = defineProps<{
  pixelsPerFrame: number;
  /** Height of the ruler above the lanes, so the band starts at the first track rather than at it. */
  rulerHeight: number;
}>();

const timelineStore = useTimelineStore();

const region = computed(() => timelineStore.onAirRegion);

const left = computed(() => (region.value?.start ?? 0) * props.pixelsPerFrame);
const width = computed(() =>
  region.value ? Math.max(1, (region.value.end - region.value.start) * props.pixelsPerFrame) : 0,
);

/**
 * Width of the "already aired" portion, from the segment start to the playhead. Clamped to the
 * region because the playhead can leave it between a frame advance and this recomputing.
 */
const airedWidth = computed(() => {
  if (!region.value) return 0;
  const frames = Math.min(timelineStore.playhead, region.value.end) - region.value.start;
  return Math.max(0, frames * props.pixelsPerFrame);
});
</script>

<template>
  <div
    v-if="region"
    class="pointer-events-none absolute z-20"
    :style="{ left: `${left}px`, width: `${width}px`, top: `${rulerHeight}px`, bottom: '0' }"
  >
    <!-- The full on-air segment. -->
    <div class="absolute inset-0 border-x border-rose-500/70 bg-rose-600/[0.18]" />
    <!-- The part of it that has already gone out. -->
    <div class="absolute inset-y-0 left-0 bg-rose-600/[0.22]" :style="{ width: `${airedWidth}px` }" />
    <!-- Leading edge — the air point itself. Kept inside the band so it stays visible when the
         playhead line sits on top of it. -->
    <div class="absolute inset-y-0 w-0.5 bg-rose-500" :style="{ left: `${airedWidth}px` }" />

    <span
      class="absolute left-1 top-1 flex items-center gap-1 rounded bg-rose-600/90 px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-widest text-white shadow-glow-rose"
    >
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
      On Air
    </span>
  </div>
</template>
