<script setup lang="ts">
/**
 * A single timeline track lane: header controls (lock/visibility/mute/solo,
 * height resize) rendered by the parent header column, and this component's
 * body renders the clip strip for that track.
 */
import TimelineClip from '@/components/timeline/TimelineClip.vue';
import { useTimelineStore } from '@/stores/timelineStore';
import type { Track } from '@/types/clip';
import { ref } from 'vue';

const props = defineProps<{
  track: Track;
  pixelsPerFrame: number;
}>();

const timelineStore = useTimelineStore();
const dragOver = ref(false);

function onClipChange(clipId: string, payload: { start: number; duration: number }): void {
  timelineStore.updateClip(clipId, payload);
}

function onDragOver(event: DragEvent): void {
  if (props.track.locked) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  dragOver.value = true;
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  if (props.track.locked) return;
  const raw = event.dataTransfer?.getData('application/x-emerald-clip');
  if (!raw) return;
  event.preventDefault();

  let data: { name: string; url: string; thumbnail?: string; durationSeconds?: number; hasAudio?: boolean };
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const startFrame = Math.max(0, Math.round((event.clientX - rect.left) / props.pixelsPerFrame));
  timelineStore.addClipFromSource({
    name: data.name,
    url: data.url,
    thumbnail: data.thumbnail,
    durationFrames: Math.round((data.durationSeconds ?? 5) * timelineStore.fps),
    trackId: props.track.id,
    startFrame,
    kind: props.track.kind === 'audio' ? 'audio' : 'video',
    hasAudio: data.hasAudio,
  });
}
</script>

<template>
  <div
    class="relative border-b border-white/5 transition-colors"
    :class="[
      track.visible ? 'bg-surface-900/40' : 'bg-surface-950/60',
      dragOver ? 'ring-1 ring-inset ring-teal-400/70 bg-teal-400/[0.06]' : '',
    ]"
    :style="{ height: `${track.height}px` }"
    @dragover="onDragOver"
    @dragleave="dragOver = false"
    @drop="onDrop"
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
