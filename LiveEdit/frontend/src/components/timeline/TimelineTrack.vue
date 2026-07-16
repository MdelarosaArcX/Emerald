<script setup lang="ts">
/**
 * A single timeline track lane: header controls (lock/visibility/mute/solo,
 * height resize) rendered by the parent header column, and this component's
 * body renders the clip strip for that track.
 */
import TimelineClip from '@/components/timeline/TimelineClip.vue';
import { useTimelineStore } from '@/stores/timelineStore';
import type { Track } from '@/types/clip';

defineProps<{
  track: Track;
  pixelsPerFrame: number;
}>();

const timelineStore = useTimelineStore();

function onClipChange(clipId: string, payload: { start: number; duration: number }): void {
  timelineStore.updateClip(clipId, payload);
}
</script>

<template>
  <div
    class="relative border-b border-white/5"
    :class="track.visible ? 'bg-surface-900/40' : 'bg-surface-950/60'"
    :style="{ height: `${track.height}px` }"
  >
    <div
      v-if="track.locked"
      class="pointer-events-none absolute inset-0 z-10"
      style="background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.02) 0 8px, transparent 8px 16px)"
    />
    <!-- Empty-lane drop affordance -->
    <div
      v-if="!track.clips.length"
      class="pointer-events-none absolute inset-1 flex items-center justify-center rounded-md border border-dashed border-rose-500/30 bg-rose-500/[0.04]"
    >
      <span class="rounded bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium tracking-wide text-rose-300/80">Drop media to Insert</span>
    </div>
    <TimelineClip
      v-for="clip in track.clips"
      :key="clip.id"
      :clip="clip"
      :pixels-per-frame="pixelsPerFrame"
      :selected="timelineStore.selectedClipId === clip.id"
      :track-locked="track.locked"
      :track-height="track.height"
      @select="timelineStore.selectClip($event)"
      @change="onClipChange(clip.id, $event)"
      @commit="onClipChange(clip.id, $event)"
    />
  </div>
</template>
