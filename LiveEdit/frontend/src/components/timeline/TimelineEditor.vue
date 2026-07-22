<script setup lang="ts">
/**
 * Bottom panel: the professional multi-track timeline editor.
 * Combines the ruler, track headers, track clip lanes, playhead,
 * and scrub cursor into one horizontally/vertically scrollable view.
 */
import TimelineCursor from '@/components/timeline/TimelineCursor.vue';
import TimelinePlayhead from '@/components/timeline/TimelinePlayhead.vue';
import TimelineRuler from '@/components/timeline/TimelineRuler.vue';
import TimelineTrack from '@/components/timeline/TimelineTrack.vue';
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
  ScissorsIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import draggable from 'vuedraggable';
import type { Track } from '@/types/clip';

defineProps<{ inspectorOpen?: boolean }>();
const emit = defineEmits<{ toggleInspector: [] }>();

const timelineStore = useTimelineStore();
const { framesToTimecode } = useTimecode(timelineStore.fps);
const playheadTimecode = computed(() => framesToTimecode(timelineStore.playhead));
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

/** Save the edit as a sequence/EDL project file (source + in/out + position per clip). */
function saveSequence(): void {
  const t = timelineStore.timeline;
  if (!t) return;
  const clips = t.tracks
    .flatMap((tr) =>
      tr.clips.map((c) => ({
        track: tr.id,
        name: c.name,
        source: c.path,
        type: c.type,
        startFrame: c.start,
        durationFrames: c.duration,
        trimInFrames: c.trimIn,
        trimOutFrames: c.trimOut,
      })),
    )
    .sort((a, b) => a.startFrame - b.startFrame);
  const project = { id: t.id, fps: t.fps, durationFrames: t.duration, clips };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'emerald-sequence.json';
  anchor.click();
  URL.revokeObjectURL(url);
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
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

const BASE_PX_PER_FRAME = 3;
const pixelsPerFrame = computed(() => BASE_PX_PER_FRAME * timelineStore.zoom);
const contentWidth = computed(() => timelineStore.duration * pixelsPerFrame.value);

/** Drag-to-reorder track list; committing a new order writes back to the store. */
const trackList = computed<Track[]>({
  get: () => timelineStore.tracks,
  set: (list) => timelineStore.reorderTracks(list.map((t) => t.id)),
});

const scrollRef = ref<HTMLElement | null>(null);

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
          class="flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300 transition hover:bg-emerald-500/20"
          title="Save the edit as a sequence file"
          @click="saveSequence"
        >
          <ArrowDownTrayIcon class="h-3.5 w-3.5" />
          Save
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
        <div class="flex items-center gap-1 rounded-md border border-white/5 bg-surface-800 px-1 py-0.5">
          <button class="rounded p-1 text-slate-400 hover:text-emerald-300" @click="timelineStore.zoomOut()">
            <MagnifyingGlassMinusIcon class="h-3.5 w-3.5" />
          </button>
          <span class="w-10 text-center font-mono text-[10px] text-slate-400">{{ Math.round(timelineStore.zoom * 100) }}%</span>
          <button class="rounded p-1 text-slate-400 hover:text-emerald-300" @click="timelineStore.zoomIn()">
            <MagnifyingGlassPlusIcon class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 overflow-y-auto">
      <!-- Track header column -->
      <div class="flex shrink-0 flex-col border-r border-white/5 bg-surface-850/60" style="width: 168px">
        <div class="h-7 shrink-0 border-b border-white/10" />
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
      <div ref="scrollRef" class="relative min-w-0 flex-1 overflow-x-auto" @mousemove="handleMouseMove" @mouseleave="handleMouseLeave">
        <div class="relative" data-timeline-content :style="{ width: `${contentWidth}px`, minWidth: '100%' }">
          <TimelineRuler
            :pixels-per-frame="pixelsPerFrame"
            :fps="timelineStore.fps"
            :duration-frames="timelineStore.duration"
            @scrub="handleScrub"
          />
          <TimelineTrack
            v-for="track in timelineStore.tracks"
            :key="track.id"
            :track="track"
            :pixels-per-frame="pixelsPerFrame"
          />
          <TimelineCursor :pixels-per-frame="pixelsPerFrame" :fps="timelineStore.fps" />
          <TimelinePlayhead :frame="timelineStore.playhead" :pixels-per-frame="pixelsPerFrame" @scrub="handleScrub" />
        </div>
      </div>
    </div>
  </section>
</template>
