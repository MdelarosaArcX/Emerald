<script setup lang="ts">
/**
 * Folder-organized media browser. Top level lists recording sessions (folders); the one currently
 * being recorded shows a LIVE badge. "Load" builds a timeline sequence from a session's segments —
 * and for the live session it keeps auto-appending newly-recorded segments (via ingestStore, polled
 * by EditorView). Open a session to browse/drag individual segments onto the timeline.
 */
import {
  fetchActiveRecording,
  fetchRecordingSessions,
  fetchSessionSegments,
  type RecordedSegment,
  type RecordingSession,
} from '@/services/emeraldPreview';
import { useIngestStore } from '@/stores/ingestStore';
import { useProgramStore } from '@/stores/programStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { ArrowPathIcon, ChevronLeftIcon, FilmIcon, FolderIcon, PlayIcon } from '@heroicons/vue/24/outline';
import { FolderIcon as FolderSolidIcon } from '@heroicons/vue/24/solid';
import { computed, onMounted, ref } from 'vue';

// `gallery` renders the sessions (directories) as a folder-icon grid — a file-explorer look for the
// non-Live-Edit media browser. Live Edit's compact stacked panel keeps the default list.
defineProps<{ gallery?: boolean }>();

const programStore = useProgramStore();
const timelineStore = useTimelineStore();
const ingestStore = useIngestStore();

const sessions = ref<RecordingSession[]>([]);
const segmentSeconds = ref(120);
const loading = ref(false);
const loaded = ref(false);

const openFolder = ref<string | null>(null);
const segments = ref<RecordedSegment[]>([]);
const segmentsLoading = ref(false);
const search = ref('');

onMounted(loadSessions);

async function loadSessions(): Promise<void> {
  loading.value = true;
  try {
    const [list, status] = await Promise.all([fetchRecordingSessions(), fetchActiveRecording()]);
    // Mark the active recording folder as live even if the sessions list is momentarily stale.
    sessions.value = list.map((s) => ({ ...s, isActive: s.isActive || (status.isRecording && s.folder === status.folder) }));
    segmentSeconds.value = status.segmentSeconds;
    ingestStore.setRecording(status.isRecording);
    loaded.value = true;
  } finally {
    loading.value = false;
  }
}

async function open(folder: string): Promise<void> {
  openFolder.value = folder;
  segmentsLoading.value = true;
  search.value = '';
  try {
    segments.value = await fetchSessionSegments(folder);
  } finally {
    segmentsLoading.value = false;
  }
}

function back(): void {
  openFolder.value = null;
  segments.value = [];
}

/** Load a session's segments as a timeline sequence; if it's the live recording, keep ingesting. */
async function loadToTimeline(session: RecordingSession): Promise<void> {
  ingestStore.setLoading(session.folder);
  try {
    const segs = await fetchSessionSegments(session.folder);
    if (!segs.length) return;
    timelineStore.loadSession({
      folder: session.folder,
      fps: programStore.fps,
      nominalSeconds: segmentSeconds.value,
      segments: segs.map((s) => ({ fileName: s.fileName, url: s.url, thumbnail: s.thumbnailUrl, index: s.index })),
    });
    if (session.isActive) ingestStore.startLive(session.folder, segmentSeconds.value);
    else ingestStore.setLoaded(session.folder);
  } finally {
    ingestStore.setLoading(null);
  }
}

const filteredSegments = computed(() =>
  segments.value.filter((s) => s.fileName.toLowerCase().includes(search.value.toLowerCase())),
);

/** The session object for the currently open folder (to Load it from inside the clips view). */
const openSession = computed(() => sessions.value.find((s) => s.folder === openFolder.value) ?? null);

/** Short folder label for the gallery tiles (drops the recorder's `emerald` prefix). */
function shortFolder(folder: string): string {
  return folder.replace(/^emerald/i, '') || folder;
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}
function formatCreated(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function previewSegment(s: RecordedSegment): void {
  programStore.loadClip({ fileName: s.fileName, sessionFolder: openFolder.value ?? '', url: s.url, thumbnailUrl: s.thumbnailUrl, size: s.size, createdAt: s.createdAt });
}
function onDragStart(event: DragEvent, s: RecordedSegment): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(
    'application/x-emerald-clip',
    JSON.stringify({ name: s.fileName, url: s.url, thumbnail: s.thumbnailUrl, durationSeconds: segmentSeconds.value }),
  );
}
</script>

<template>
  <section class="flex h-full min-w-0 flex-1 flex-col gap-2 rounded-xl border border-white/5 bg-surface-900/80 p-2.5 shadow-panel">
    <!-- Breadcrumb -->
    <div class="flex items-center gap-2">
      <button
        class="flex h-7 w-8 items-center justify-center rounded-md border border-white/10 bg-surface-800 text-slate-400 transition hover:text-teal-300 disabled:opacity-40"
        :disabled="!openFolder"
        title="Back to sessions"
        @click="back"
      >
        <ChevronLeftIcon class="h-4 w-4" />
      </button>
      <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/10 bg-surface-800 px-2 py-1">
        <FolderIcon class="h-4 w-4 shrink-0 text-emerald-400" />
        <span class="truncate font-mono text-xs" :class="openFolder ? 'text-slate-200' : 'font-semibold text-emerald-300'">{{ openFolder ?? 'Video Library' }}</span>
      </div>
      <button
        class="flex h-7 w-8 items-center justify-center rounded-md border border-white/10 bg-surface-800 text-slate-400 transition hover:text-teal-300"
        :class="{ 'animate-spin': loading }"
        title="Refresh"
        @click="openFolder ? open(openFolder) : loadSessions()"
      >
        <ArrowPathIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- SESSIONS gallery (directory) view — folder-icon grid, file-explorer style -->
    <div v-if="!openFolder && gallery" class="min-h-0 flex-1 overflow-y-auto pr-0.5">
      <div class="grid grid-cols-3 gap-1">
        <button
          v-for="session in sessions"
          :key="session.folder"
          class="group relative flex flex-col items-center gap-0.5 rounded-lg p-2 transition hover:bg-white/5"
          :title="`Open ${session.folder}` + (session.isActive ? ' — recording' : '') + ' · double-click to load'"
          @click="open(session.folder)"
          @dblclick="loadToTimeline(session)"
        >
          <div class="relative">
            <FolderSolidIcon class="h-16 w-16 text-[#26304f] drop-shadow-sm transition group-hover:text-[#31406b]" />
            <span
              v-if="session.isActive"
              class="absolute right-2 top-4 flex items-center gap-0.5 rounded-full bg-rose-500/90 px-1 py-[1px] text-[7px] font-bold uppercase leading-none text-white"
            >
              <span class="h-1 w-1 animate-blink rounded-full bg-white" />live
            </span>
          </div>
          <span
            class="w-full truncate text-center font-mono text-[11px]"
            :class="ingestStore.loadedFolder === session.folder ? 'text-teal-300' : 'text-slate-200'"
          >
            {{ shortFolder(session.folder) }}
          </span>
        </button>
      </div>
      <div v-if="loading" class="mt-6 flex flex-col items-center gap-2 text-center text-xs text-slate-500">
        <ArrowPathIcon class="h-5 w-5 animate-spin text-teal-400" />
        Loading…
      </div>
      <p v-else-if="loaded && !sessions.length" class="mt-6 text-center text-xs text-slate-600">No recording sessions found on the Emerald backend.</p>
    </div>

    <!-- SESSIONS list view (compact — used in Live Edit's stacked panel) -->
    <div v-else-if="!openFolder" class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
      <div
        v-for="session in sessions"
        :key="session.folder"
        class="rounded-lg border p-2.5 transition"
        :class="ingestStore.loadedFolder === session.folder ? 'border-teal-400/60 bg-teal-400/[0.06]' : 'border-white/5 bg-surface-850/70'"
      >
        <div class="flex items-center gap-2">
          <button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" title="Open session" @click="open(session.folder)">
            <FolderIcon class="h-4 w-4 shrink-0 text-emerald-400" />
            <span class="truncate font-mono text-[11px] text-slate-200">{{ session.folder }}</span>
            <span v-if="session.isActive" class="flex shrink-0 items-center gap-1 rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-rose-300">
              <span class="h-1.5 w-1.5 animate-blink rounded-full bg-rose-500" /> Live
            </span>
          </button>
          <button
            class="flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300 transition hover:bg-emerald-500/20"
            :title="session.isActive ? 'Load live session (auto-ingests new segments)' : 'Load session to the timeline'"
            @click="loadToTimeline(session)"
          >
            <PlayIcon class="h-3 w-3" />
            {{ session.isActive ? 'Live' : 'Load' }}
          </button>
        </div>
        <div class="mt-1 flex items-center gap-3 pl-6 font-mono text-[10px] text-slate-500">
          <span>{{ session.segmentCount }} clips</span>
          <span>{{ formatSize(session.size) }}</span>
          <span>{{ formatCreated(session.createdAt) }}</span>
        </div>
      </div>

      <div v-if="loading" class="mt-6 flex flex-col items-center gap-2 text-center text-xs text-slate-500">
        <ArrowPathIcon class="h-5 w-5 animate-spin text-teal-400" />
        Loading sessions…
      </div>
      <p v-else-if="loaded && !sessions.length" class="mt-6 text-center text-xs text-slate-600">No recording sessions found on the Emerald backend.</p>
    </div>

    <!-- CLIPS view (within a session) -->
    <template v-else>
      <div class="flex items-center gap-2">
        <input
          v-model="search"
          type="text"
          placeholder="Search clips…"
          class="min-w-0 flex-1 rounded-md border border-white/10 bg-surface-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
        />
        <button
          v-if="openSession"
          class="flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-medium text-emerald-300 transition hover:bg-emerald-500/20"
          :title="openSession.isActive ? 'Load live session (auto-ingests new segments)' : 'Load this session to the timeline'"
          @click="loadToTimeline(openSession)"
        >
          <PlayIcon class="h-3.5 w-3.5" />
          {{ openSession.isActive ? 'Live' : 'Load' }}
        </button>
      </div>
      <div class="grid min-h-0 flex-1 grid-cols-2 auto-rows-min gap-2.5 overflow-y-auto pr-0.5">
        <button
          v-for="s in filteredSegments"
          :key="s.fileName"
          class="group flex cursor-grab flex-col overflow-hidden rounded-lg border text-left transition active:cursor-grabbing"
          :class="programStore.clip?.url === s.url ? 'border-teal-400 shadow-glow-teal' : 'border-white/5 bg-surface-850/70 hover:border-teal-500/40'"
          draggable="true"
          title="Click to preview · drag onto the timeline to edit"
          @click="previewSegment(s)"
          @dragstart="onDragStart($event, s)"
        >
          <div class="relative h-[72px] w-full shrink-0 overflow-hidden bg-black">
            <img :src="s.thumbnailUrl" :alt="s.fileName" class="absolute inset-0 h-full w-full object-cover" loading="lazy" @error="($event.target as HTMLImageElement).style.visibility = 'hidden'" />
            <FilmIcon class="pointer-events-none absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-white/20" />
            <span class="absolute right-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white/80">MP4</span>
          </div>
          <div class="space-y-0.5 px-1.5 py-1.5">
            <p class="truncate text-[11px] font-medium text-slate-200">{{ s.fileName }}</p>
            <p class="font-mono text-[10px] text-slate-500">{{ formatSize(s.size) }} · {{ formatTime(s.createdAt) }}</p>
          </div>
        </button>

        <div v-if="segmentsLoading" class="col-span-2 mt-6 flex flex-col items-center gap-2 text-center text-xs text-slate-500">
          <ArrowPathIcon class="h-5 w-5 animate-spin text-teal-400" />
          Loading clips…
        </div>
        <p v-else-if="!filteredSegments.length" class="col-span-2 mt-6 text-center text-xs text-slate-600">No clips in this session.</p>
      </div>
    </template>
  </section>
</template>
