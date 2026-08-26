<script setup lang="ts">
/**
 * A single timeline track lane: header controls (lock/visibility/mute/solo,
 * height resize) rendered by the parent header column, and this component's
 * body renders the clip strip for that track.
 */
import { useProjectStore } from '@/stores/projectStore';
import TimelineClip from '@/components/timeline/TimelineClip.vue';
import { useTimelineStore } from '@/stores/timelineStore';
import type { Track } from '@/types/clip';
import { ref } from 'vue';

const props = defineProps<{
  track: Track;
  pixelsPerFrame: number;
}>();

const timelineStore = useTimelineStore();
const projectStore = useProjectStore();
const dragOver = ref(false);
/** True while the drag in progress carries OS files rather than an asset from a browser panel. */
const importing = ref(false);

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

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const droppedFrame = Math.max(0, Math.round((event.clientX - rect.left) / props.pixelsPerFrame));

  // Files dragged in from the desktop are imported first and then inserted, so a file goes from
  // Explorer to the timeline in one gesture. The measurement above happens before any awaiting:
  // the DragEvent's coordinates are only meaningful while the event is being handled.
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) {
    event.preventDefault();
    await importAndInsert(files, droppedFrame);
    return;
  }

  const raw = event.dataTransfer?.getData('application/x-emerald-clip');
  if (!raw) return;
  event.preventDefault();

  let data: { name: string; url: string; thumbnail?: string; durationSeconds?: number; hasAudio?: boolean };
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  // Where you dropped it is where it goes.
  //
  // This used to place a source that carries its own timecode at that timecode instead — Emerald's
  // clip export stamps one (a QuickTime tmcd track), so an exported file dropped back on the
  // timeline landed at the position it was captured at, ready to be conformed against the
  // original. The trouble is that it did so silently and unconditionally: drag a clip to 10:42 and
  // it vanishes to wherever it was recorded, possibly hours away and off screen, with nothing to
  // say why. A drop is a direct instruction about position and has to be honoured as one — the
  // same reasoning importAndInsert() below already applies to desktop files.
  //
  // Conforming is still available deliberately, by holding Shift while dropping. Awaited before
  // inserting rather than inserting and moving afterwards: a clip that visibly jumps after landing
  // looks like a bug, and the read is a cached ffprobe of a local file.
  const conformToSourceTimecode = event.shiftKey;
  const timecodeFrame = conformToSourceTimecode
    ? await fetchSourceTimecodeFrame(data.url, timelineStore.fps)
    : null;

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
 * Imports desktop files into the project library, then lays them onto this track from the drop
 * point, each one starting where the previous ended.
 *
 * Laid end to end rather than all at the drop frame because a multi-file drop is a request for a
 * sequence — stacking them on one frame would hide every file but the last behind the others.
 *
 * Unlike the asset path below, no timecode lookup is attempted: an imported file's embedded
 * timecode (if any) refers to whatever system recorded it, and honouring it would fling the clip
 * to an unrelated part of the timeline instead of where it was dropped.
 */
async function importAndInsert(files: File[], startFrame: number): Promise<void> {
  importing.value = true;
  try {
    const assets = await projectStore.importFiles(files);
    let frame = startFrame;

    for (const asset of assets) {
      // Stills have no duration of their own; they get a default so they are visible and
      // trimmable rather than landing as a zero-width clip.
      const durationFrames = Math.max(1, Math.round((asset.duration || 5) * timelineStore.fps));

      timelineStore.addClipFromSource({
        name: asset.name,
        url: asset.path,
        thumbnail: asset.thumbnail,
        durationFrames,
        trackId: props.track.id,
        startFrame: frame,
        kind: props.track.kind === 'audio' ? 'audio' : 'video',
        hasAudio: asset.hasAudio,
      });

      frame += durationFrames;
    }
  } finally {
    importing.value = false;
  }
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
    <!-- A dropped file can take a while to upload and probe, and until it does the lane looks
         exactly as it did before the drop. -->
    <div
      v-if="importing"
      class="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-md border border-dashed border-emerald-400/50 bg-emerald-400/[0.07]"
    >
      <span class="rounded bg-emerald-500/20 px-2 py-0.5 text-[0.625rem] font-medium tracking-wide text-emerald-200">
        Importing…
      </span>
    </div>
    <!-- Empty-lane drop affordance -->
    <div
      v-if="!track.clips.length && !importing"
      class="pointer-events-none absolute inset-1 flex items-center justify-center rounded-md border border-dashed border-rose-500/30 bg-rose-500/[0.04]"
    >
      <span class="rounded bg-rose-500/15 px-2 py-0.5 text-[0.625rem] font-medium tracking-wide text-rose-300/80">Drop media to Insert</span>
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
