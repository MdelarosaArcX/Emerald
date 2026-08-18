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

async function onDrop(event: DragEvent): Promise<void> {
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
  const droppedFrame = Math.max(0, Math.round((event.clientX - rect.left) / props.pixelsPerFrame));

  // A source that carries its own timecode is placed at that timecode rather than where the
  // pointer happened to land. Emerald's clip export stamps one (a QuickTime tmcd track), which is
  // what makes an exported file drop back onto the timeline at the position it was captured at —
  // so a re-export can be conformed against the original without lining it up by hand.
  //
  // Awaited before inserting rather than inserting and moving afterwards: a clip that visibly
  // jumps after landing looks like a bug, and the read is a cached ffprobe of a local file.
  const timecodeFrame = await fetchSourceTimecodeFrame(data.url, timelineStore.fps);

  timelineStore.addClipFromSource({
    name: data.name,
    url: data.url,
    thumbnail: data.thumbnail,
    durationFrames: Math.round((data.durationSeconds ?? 5) * timelineStore.fps),
    trackId: props.track.id,
    startFrame: timecodeFrame ?? droppedFrame,
    kind: props.track.kind === 'audio' ? 'audio' : 'video',
    hasAudio: data.hasAudio,
  });
}

/**
 * Frame offset from midnight for a source's embedded timecode, or null when it has none.
 *
 * Midnight-relative because that is the origin the rest of this timeline counts from (see
 * timelineStore's handling of live segments, which converts their capture time the same way), so
 * an exported clip and the live segments it came from land on the same scale.
 */
async function fetchSourceTimecodeFrame(url: string, fps: number): Promise<number | null> {
  if (!/^https?:/i.test(url)) return null;

  try {
    const response = await fetch(`/api/source-timecode?url=${encodeURIComponent(url)}`);
    if (!response.ok) return null;

    const body = (await response.json()) as { data?: { timecode?: string | null } };
    const timecode = body.data?.timecode;
    if (!timecode) return null;

    // Drop-frame sources use ';' before the frames field; the separator is accepted but the
    // arithmetic below is non-drop, matching how the rest of the editor counts.
    const match = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(timecode);
    if (!match) return null;

    const [, hours, minutes, seconds, frames] = match.map(Number);
    return Math.round(((hours * 3600 + minutes * 60 + seconds) * fps) + frames);
  } catch {
    return null;
  }
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
      :fps="timelineStore.fps"
      @select="timelineStore.selectClip($event)"
      @change="onClipChange(clip.id, $event)"
      @commit="onClipChange(clip.id, $event)"
    />
  </div>
</template>
