<script setup lang="ts">
/**
 * Bottom panel: the professional multi-track timeline editor.
 * Combines the ruler, track headers, track clip lanes, playhead,
 * and scrub cursor into one horizontally/vertically scrollable view.
 */
import TimelineCursor from '@/components/timeline/TimelineCursor.vue';
import TimelineOnAirRegion from '@/components/timeline/TimelineOnAirRegion.vue';
import TimelinePlayhead from '@/components/timeline/TimelinePlayhead.vue';
import TimelineRuler from '@/components/timeline/TimelineRuler.vue';
import TimelineTrack from '@/components/timeline/TimelineTrack.vue';
import { renderSequence } from '@/services/render';
import { useOnAirStore } from '@/stores/onAirStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useTimecode } from '@/composables/useTimecode';
import {
  AdjustmentsHorizontalIcon,
  ArrowDownTrayIcon,
  Bars3Icon,
  EyeIcon,
  EyeSlashIcon,
  LockClosedIcon,
  LockOpenIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  PlusIcon,
  ScissorsIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import draggable from 'vuedraggable';
import type { Track } from '@/types/clip';

defineProps<{ inspectorOpen?: boolean }>();
const emit = defineEmits<{ toggleInspector: [] }>();

const timelineStore = useTimelineStore();
const onAirStore = useOnAirStore();
const { framesToTimecode } = useTimecode(() => timelineStore.fps);
const playheadTimecode = computed(() => framesToTimecode(timelineStore.playhead));

/** Timecode air started at — what the ON AIR readout in the header reports. */
const onAirStartTimecode = computed(() =>
  onAirStore.startedFrame === null ? '--:--:--:--' : framesToTimecode(onAirStore.startedFrame),
);

/** Follow On Air button state: engaged and receiving, engaged but off air, or unreachable. */
const followTitle = computed(() => {
  if (!onAirStore.following) return 'Follow Emerald TX — park the playhead on what is going to air and scroll with it';
  if (!onAirStore.reachable) return 'Following on air — Emerald is not answering; holding the last known position';
  if (!onAirStore.transmitting) return 'Following on air — TX is not transmitting right now';
  return `On air since ${onAirStartTimecode.value} — click to stop following`;
});
const hasSelection = computed(() => timelineStore.selectedClip !== null);

/** Whether the playhead currently sits inside an unlocked clip (so a cut is possible). */
const canSplit = computed(() => {
  const frame = timelineStore.playhead;
  return timelineStore.tracks.some(
    (t) => !t.locked && t.clips.some((c) => frame > c.start && frame < c.start + c.duration),
  );
});

/** Razor cut every clip the playhead crosses. */
function splitAtPlayhead(): void {
  timelineStore.splitAtPlayhead();
}

function deleteSelected(): void {
  const clip = timelineStore.selectedClip;
  if (clip) timelineStore.removeClip(clip.id);
}

const rendering = ref(false);

/** Render the sequence into one MP4 via the backend (trim + concat), then open the result. */
async function saveSequence(): Promise<void> {
  const t = timelineStore.timeline;
  if (!t || rendering.value) return;
  const clips = t.tracks
    .filter((tr) => tr.kind !== 'audio')
    .flatMap((tr) => tr.clips)
    .filter((c) => /^https?:/i.test(c.path))
    .sort((a, b) => a.start - b.start)
    .map((c) => ({ url: c.path, trimInFrames: c.trimIn, trimOutFrames: c.trimOut }));
  if (!clips.length) {
    window.alert('Add a recorded clip to the timeline first — there is nothing to render.');
    return;
  }
  rendering.value = true;
  try {
    const url = await renderSequence(clips, t.fps);
    if (url) window.open(url, '_blank');
  } catch (err) {
    window.alert(err instanceof Error ? err.message : 'Render failed');
  } finally {
    rendering.value = false;
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function onKeydown(event: KeyboardEvent): void {
  if (isTypingTarget(event.target)) return;
  if ((event.key === 'Delete' || event.key === 'Backspace') && timelineStore.selectedClip) {
    event.preventDefault();
    deleteSelected();
  } else if (event.key === 'x' && canSplit.value) {
    event.preventDefault();
    splitAtPlayhead();
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  syncViewport();
  if (scrollRef.value && typeof ResizeObserver !== 'undefined') {
    viewportObserver = new ResizeObserver(syncViewport);
    viewportObserver.observe(scrollRef.value);
  }
  // The toggle is persisted, so an operator who left the editor following air comes back still
  // following. Polling is tied to this component rather than started globally so navigating away
  // from the editor doesn't leave a poll running against Emerald for a timeline nobody is watching.
  if (onAirStore.following) onAirStore.setFollowing(true);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  onAirStore.stopPolling();
  viewportObserver?.disconnect();
  viewportObserver = null;
});

/**
 * Height of the ruler strip. Owned here rather than left as a utility class on TimelineRuler
 * because the on-air band has to start exactly where the lanes do, and the track-header column has
 * to reserve exactly the same gap — three places that silently misalign if they drift apart.
 */
const RULER_HEIGHT_PX = 28;

const BASE_PX_PER_FRAME = 3;
const pixelsPerFrame = computed(() => BASE_PX_PER_FRAME * timelineStore.zoom);
const contentWidth = computed(() => timelineStore.duration * pixelsPerFrame.value);

// The zoom at which the entire timeline fits the visible viewport — the floor for zoom-out, so
// "max zoom-out" shows everything fully compressed rather than stopping at an arbitrary minimum.
function fitZoom(): number {
  const el = scrollRef.value;
  const frames = timelineStore.duration;
  if (!el || frames <= 0) return 0.02;
  // Leave headroom so the whole content sits inside the viewport with no residual scroll (the track
  // lanes render a little past the nominal content width).
  const usable = Math.max(0, el.clientWidth - 88);
  return Math.min(1, Math.max(0.0002, usable / (frames * BASE_PX_PER_FRAME)));
}
function zoomIn(): void {
  timelineStore.setZoom(timelineStore.zoom * 1.25);
}
function zoomOut(): void {
  timelineStore.setZoom(Math.max(fitZoom(), timelineStore.zoom / 1.25));
}
function zoomFit(): void {
  timelineStore.setZoom(fitZoom());
}

/** Drag-to-reorder track list; committing a new order writes back to the store. */
const trackList = computed<Track[]>({
  get: () => timelineStore.tracks,
  set: (list) => timelineStore.reorderTracks(list.map((t) => t.id)),
});

const scrollRef = ref<HTMLElement | null>(null);

// The horizontal scroll window, tracked so TimelineRuler can draw only the ticks in view — see its
// `ticks` comment for why that matters on a timeline that spans a whole day.
const viewportLeftPx = ref(0);
const viewportWidthPx = ref(0);

function syncViewport(): void {
  const el = scrollRef.value;
  if (!el) return;
  viewportLeftPx.value = el.scrollLeft;
  viewportWidthPx.value = el.clientWidth;
}

// Width changes without a scroll event whenever the splitpanes layout moves or the inspector opens,
// and clientWidth reads 0 while the pane is hidden — an observer catches both, where a one-off
// measurement on mount would leave the ruler sized for a stale (or zero-width) viewport.
let viewportObserver: ResizeObserver | null = null;

// While playing — or while following Emerald's on-air output — keep the playhead pinned near the
// left edge of the visible viewport so the timeline visibly scrolls right-to-left underneath it
// instead of requiring a manual scroll to follow along. Left untouched while paused and not
// following, so manual scrubbing/panning is never fought.
const FOLLOW_MARGIN_PX = 80;
watch(
  () => timelineStore.playhead,
  (frame) => {
    if (!timelineStore.isPlaying && !onAirStore.active) return;
    const el = scrollRef.value;
    if (!el) return;
    el.scrollLeft = Math.max(0, frame * pixelsPerFrame.value - FOLLOW_MARGIN_PX);
  },
);

// Jumps the viewport to a just-landed live-captured segment on V4 (see timelineStore's
// pendingScrollFrame doc comment) — frame 0 is midnight, so without this the operator would have
// to manually scroll from 0 all the way to wherever "now" is (e.g. 21:52:00) every time.
watch(
  () => timelineStore.pendingScrollFrame,
  async (frame) => {
    if (frame == null) return;
    // The new clip just widened timeline.duration (hence contentWidth) — wait for that to
    // actually reach the DOM, otherwise the browser clamps scrollLeft to the still-old, narrower
    // scrollWidth instead of the position we're about to set.
    await nextTick();
    const el = scrollRef.value;
    if (el) el.scrollLeft = Math.max(0, frame * pixelsPerFrame.value - FOLLOW_MARGIN_PX);
    timelineStore.pendingScrollFrame = null;
  },
);

function handleScrub(frames: number): void {
  timelineStore.setPlayhead(frames);
}

function handleMouseMove(event: MouseEvent): void {
  const el = scrollRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = event.clientX - rect.left + el.scrollLeft;
  timelineStore.setMouseFrame(Math.max(0, Math.round(x / pixelsPerFrame.value)));
}

function handleMouseLeave(): void {
  timelineStore.setMouseFrame(null);
}

function startHeightDrag(event: PointerEvent, trackId: string, startHeight: number): void {
  const startY = event.clientY;

  function move(e: PointerEvent): void {
    timelineStore.resizeTrackHeight(trackId, startHeight + (e.clientY - startY));
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
  <section class="flex h-full flex-col rounded-xl border border-white/5 bg-surface-900/80 shadow-panel">
    <header class="flex shrink-0 items-center justify-between border-b border-white/5 px-3 py-2">
      <div class="flex items-center gap-3">
        <span class="rounded-md border border-rose-500/50 bg-rose-500/15 px-2 py-1 font-mono text-xs font-semibold tracking-wider text-rose-300 shadow-glow-rose">
          {{ playheadTimecode }}
        </span>
        <h2 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Timeline</h2>

        <!-- Follow On Air: parks the playhead on Emerald's TX timecode and scrolls with it. -->
        <button
          class="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition"
          :class="onAirStore.following
            ? (onAirStore.active
              ? 'border-rose-500/60 bg-rose-500/15 text-rose-300 shadow-glow-rose'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300')
            : 'border-white/5 text-slate-500 hover:border-rose-400/40 hover:text-rose-300'"
          :title="followTitle"
          @click="onAirStore.toggleFollow()"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="onAirStore.active ? 'animate-pulse bg-rose-400' : onAirStore.following ? 'bg-amber-400' : 'bg-slate-600'"
          />
          Follow Air
        </button>

        <!-- The timecode air started at, which is the whole point of following: it anchors what is
             on the timeline to when the transmission actually began. -->
        <span
          v-if="onAirStore.active"
          class="font-mono text-[10px] text-slate-500"
          :title="onAirStore.startedAt ? `TX started ${new Date(onAirStore.startedAt).toLocaleString()}` : ''"
        >
          ON AIR FROM <span class="text-rose-300">{{ onAirStartTimecode }}</span>
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-1 rounded-md border border-white/5 px-2 py-1 text-[10px] font-medium text-slate-400 transition hover:border-teal-400/40 hover:text-teal-300 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!canSplit"
          title="Cut / split the clip(s) under the playhead (X). Move the playhead into a clip first."
          @click="splitAtPlayhead"
        >
          <ScissorsIcon class="h-3.5 w-3.5" />
          Cut
        </button>
        <button
          class="flex items-center gap-1 rounded-md border border-white/5 px-2 py-1 text-[10px] font-medium text-slate-400 transition hover:border-rose-400/40 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!hasSelection"
          title="Delete selected clip (Del)"
          @click="deleteSelected"
        >
          <TrashIcon class="h-3.5 w-3.5" />
          Del
        </button>
        <button
          class="flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-wait disabled:opacity-60"
          :disabled="rendering"
          title="Render the sequence into one video (trim + concat)"
          @click="saveSequence"
        >
          <ArrowDownTrayIcon class="h-3.5 w-3.5" :class="{ 'animate-pulse': rendering }" />
          {{ rendering ? 'Rendering…' : 'Save' }}
        </button>
        <span class="h-4 w-px bg-white/10" />
        <button
          class="flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition"
          :class="inspectorOpen ? 'border-teal-400/50 bg-teal-400/10 text-teal-300' : 'border-white/5 text-slate-500 hover:text-slate-300'"
          title="Toggle Video / Audio FX inspector"
          @click="emit('toggleInspector')"
        >
          <AdjustmentsHorizontalIcon class="h-3.5 w-3.5" />
          FX
        </button>
        <button
          class="rounded-md border border-white/5 px-2 py-1 text-[10px] font-medium transition"
          :class="timelineStore.snapEnabled ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'text-slate-500 hover:text-slate-300'"
          @click="timelineStore.toggleSnap()"
        >
          SNAP
        </button>
        <div class="flex items-center gap-0.5 rounded-md border border-white/5 bg-surface-800 px-1 py-0.5">
          <span class="px-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-500">Add</span>
          <button class="flex items-center rounded px-1 py-0.5 text-[10px] font-bold text-slate-400 transition hover:text-teal-300" title="Add a video track (overlapping / layered video)" @click="timelineStore.addTrack('video')">
            <PlusIcon class="h-3 w-3" />V
          </button>
          <button class="flex items-center rounded px-1 py-0.5 text-[10px] font-bold text-slate-400 transition hover:text-emerald-300" title="Add an audio track" @click="timelineStore.addTrack('audio')">
            <PlusIcon class="h-3 w-3" />A
          </button>
        </div>
        <div class="flex items-center gap-1 rounded-md border border-white/5 bg-surface-800 px-1 py-0.5">
          <button class="rounded p-1 text-slate-400 hover:text-emerald-300" title="Zoom out" @click="zoomOut()">
            <MagnifyingGlassMinusIcon class="h-3.5 w-3.5" />
          </button>
          <span class="w-10 text-center font-mono text-[10px] text-slate-400">{{ Math.round(timelineStore.zoom * 100) }}%</span>
          <button class="rounded p-1 text-slate-400 hover:text-emerald-300" title="Zoom in" @click="zoomIn()">
            <MagnifyingGlassPlusIcon class="h-3.5 w-3.5" />
          </button>
          <button class="rounded px-1 text-[9px] font-bold text-slate-400 transition hover:text-emerald-300" title="Fit the whole timeline to the view" @click="zoomFit()">
            FIT
          </button>
        </div>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 overflow-y-auto">
      <!-- Track header column -->
      <div class="flex shrink-0 flex-col border-r border-white/5 bg-surface-850/60" style="width: 168px">
        <div class="shrink-0 border-b border-white/10" :style="{ height: `${RULER_HEIGHT_PX}px` }" />
        <draggable v-model="trackList" item-key="id" handle=".track-drag-handle" tag="div" class="flex flex-col">
          <template #item="{ element: track }">
            <div
              class="relative flex shrink-0 flex-col justify-center gap-1 border-b border-white/5 px-2.5 py-1.5"
              :style="{ height: `${track.height}px` }"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1">
                  <Bars3Icon class="track-drag-handle h-3.5 w-3.5 cursor-grab text-slate-600 hover:text-slate-400" />
                  <span class="text-xs font-semibold text-slate-300">{{ track.name }}</span>
                </div>
                <div class="flex items-center gap-0.5">
                  <button
                    class="rounded p-0.5 transition"
                    :class="track.locked ? 'text-amber-400' : 'text-slate-500 hover:text-slate-300'"
                    title="Lock track"
                    @click="timelineStore.toggleTrackLock(track.id)"
                  >
                    <component :is="track.locked ? LockClosedIcon : LockOpenIcon" class="h-3.5 w-3.5" />
                  </button>
                  <button
                    class="rounded p-0.5 transition"
                    :class="track.visible ? 'text-slate-500 hover:text-slate-300' : 'text-rose-400'"
                    title="Toggle visibility"
                    @click="timelineStore.toggleTrackVisibility(track.id)"
                  >
                    <component :is="track.visible ? EyeIcon : EyeSlashIcon" class="h-3.5 w-3.5" />
                  </button>
                  <button
                    class="rounded p-0.5 text-slate-600 transition hover:text-rose-400"
                    title="Remove track"
                    @click="timelineStore.removeTrack(track.id)"
                  >
                    <XMarkIcon class="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div class="flex items-center gap-1">
                <button
                  class="rounded p-0.5 transition"
                  :class="track.muted ? 'text-rose-400' : 'text-slate-500 hover:text-slate-300'"
                  title="Mute track"
                  @click="timelineStore.toggleTrackMute(track.id)"
                >
                  <component :is="track.muted ? SpeakerXMarkIcon : SpeakerWaveIcon" class="h-3.5 w-3.5" />
                </button>
                <button
                  class="rounded border px-1 text-[9px] font-bold transition"
                  :class="track.solo ? 'border-teal-400 bg-teal-400/10 text-teal-300' : 'border-white/10 text-slate-500 hover:text-slate-300'"
                  title="Solo track"
                  @click="timelineStore.toggleTrackSolo(track.id)"
                >
                  S
                </button>
              </div>
              <div
                class="absolute bottom-0 left-0 right-0 h-1 cursor-ns-resize hover:bg-teal-500/40"
                @pointerdown="startHeightDrag($event, track.id, track.height)"
              />
            </div>
          </template>
        </draggable>
      </div>

      <!-- Scrollable timeline content -->
      <div
        ref="scrollRef"
        class="relative min-w-0 flex-1 overflow-x-auto"
        @scroll="syncViewport"
        @mousemove="handleMouseMove"
        @mouseleave="handleMouseLeave"
      >
        <div class="relative" data-timeline-content :style="{ width: `${contentWidth}px`, minWidth: '100%' }">
          <TimelineRuler
            :pixels-per-frame="pixelsPerFrame"
            :fps="timelineStore.fps"
            :duration-frames="timelineStore.duration"
            :height="RULER_HEIGHT_PX"
            :viewport-start-px="viewportLeftPx"
            :viewport-end-px="viewportLeftPx + viewportWidthPx"
            @scrub="handleScrub"
          />
          <TimelineTrack
            v-for="track in timelineStore.tracks"
            :key="track.id"
            :track="track"
            :pixels-per-frame="pixelsPerFrame"
          />
          <TimelineOnAirRegion :pixels-per-frame="pixelsPerFrame" :ruler-height="RULER_HEIGHT_PX" />
          <TimelineCursor :pixels-per-frame="pixelsPerFrame" :fps="timelineStore.fps" />
          <TimelinePlayhead :frame="timelineStore.playhead" :pixels-per-frame="pixelsPerFrame" @scrub="handleScrub" />
        </div>
      </div>
    </div>
  </section>
</template>
