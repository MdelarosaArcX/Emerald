<script setup lang="ts">
/**
 * Saved-clips browser for the left deck.
 *
 * Two layouts, chosen by the `gallery` prop:
 *  - gallery (the tabbed "Media Browser" panel): opens on the Video Library — a file-explorer
 *    style grid of recording-session folders. Opening one drills into that session's clips.
 *  - default (Live Edit's stacked column): the flat two-column clip grid for the active session,
 *    which is all that column has the height for once the preview above it takes its share.
 *
 * Either way, clicking a clip loads it into the center Program monitor (via programStore) and
 * dragging one onto the timeline inserts it.
 */
import {
  fetchRecordedClips,
  fetchRecordingSessions,
  fetchSessionClips,
  type RecordedClip,
  type RecordingSession,
} from '@/services/emeraldPreview';
import { useProgramStore } from '@/stores/programStore';
import { useTimelineStore } from '@/stores/timelineStore';
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  FilmIcon,
  FolderIcon,
} from '@heroicons/vue/24/outline';
import { FolderIcon as FolderSolidIcon } from '@heroicons/vue/24/solid';
import { computed, onMounted, ref } from 'vue';

const props = defineProps<{ gallery?: boolean }>();

const programStore = useProgramStore();
const timelineStore = useTimelineStore();

// Fallback length only for the rare case a clip's real duration hasn't been probed yet (e.g. the
// still-recording last segment of an active session) — every finished segment carries its real
// ffprobed durationSeconds from the backend (see emeraldPreview.ts) and that's used instead.
const DEFAULT_LOAD_SECONDS = 30;

const sessions = ref<RecordingSession[]>([]);
const sessionsLoaded = ref(false);

const clips = ref<RecordedClip[]>([]);
const loading = ref(false);
const loaded = ref(false);
const search = ref('');

/** null while the gallery is showing the session list; a folder name once one is opened. */
const openFolder = ref<string | null>(null);

onMounted(async () => {
  // The flat layout has no library level to show, so it goes straight to the active session's
  // clips; the gallery starts at the folder grid and loads clips only once one is opened.
  if (props.gallery) await loadSessions();
  else await loadActiveSessionClips();
});

async function loadSessions(): Promise<void> {
  loading.value = true;
  try {
    sessions.value = await fetchRecordingSessions();
    sessionsLoaded.value = true;
  } finally {
    loading.value = false;
  }
}

async function loadActiveSessionClips(): Promise<void> {
  loading.value = true;
  try {
    clips.value = await fetchRecordedClips();
    loaded.value = true;
  } finally {
    loading.value = false;
  }
}

async function open(folder: string): Promise<void> {
  openFolder.value = folder;
  search.value = '';
  clips.value = [];
  loaded.value = false;
  loading.value = true;
  try {
    clips.value = await fetchSessionClips(folder);
    loaded.value = true;
  } finally {
    loading.value = false;
  }
}

function back(): void {
  openFolder.value = null;
  clips.value = [];
  loaded.value = false;
  search.value = '';
}

function refresh(): void {
  if (!props.gallery) void loadActiveSessionClips();
  else if (openFolder.value) void open(openFolder.value);
  else void loadSessions();
}

// clips.value also holds "ts" segments (raw HLS chunks for a still-recording session) fetched
// alongside the "mp4" ones — kept in memory so playback/timeline code can reach the live tail of
// an active session, but never shown in this grid, which is clip browsing, not raw segment
// browsing.
const filtered = computed(() =>
  clips.value.filter((c) => c.kind === 'mp4' && c.fileName.toLowerCase().includes(search.value.toLowerCase())),
);

/** Breadcrumb label: the library root, the open folder, or the active session in flat mode. */
const breadcrumb = computed(() => {
  if (props.gallery) return openFolder.value ?? 'Video Library';
  return clips.value[0]?.sessionFolder ?? 'Recordings';
});

/** Whether the clip grid is the thing on screen right now. */
const showingClips = computed(() => !props.gallery || openFolder.value !== null);

/** Compact label for a folder tile — drops the recorder's `emerald` prefix when there is one. */
function shortFolder(folder: string): string {
  return folder.replace(/^emerald/i, '') || folder;
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function pick(clip: RecordedClip): void {
  programStore.loadClip(clip);
  // Build a fresh single-clip timeline around this clip so it previews in the center and can be
  // edited (cut / trim / effects). Drag additional clips onto the timeline to build a sequence.
  timelineStore.loadProgramClip({
    name: clip.fileName,
    thumbnail: clip.thumbnailUrl ?? '',
    url: clip.url,
    durationFrames: Math.round((clip.durationSeconds ?? DEFAULT_LOAD_SECONDS) * programStore.fps),
    fps: programStore.fps,
    hasAudio: clip.hasAudio !== false,
  });
}

function onDragStart(event: DragEvent, clip: RecordedClip): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(
    'application/x-emerald-clip',
    JSON.stringify({
      name: clip.fileName,
      url: clip.url,
      thumbnail: clip.thumbnailUrl,
      // Real ffprobed duration from the backend; only falls back to a placeholder for a segment
      // that hasn't been probed yet (still actively recording).
      durationSeconds: clip.durationSeconds ?? DEFAULT_LOAD_SECONDS,
      // hasAudio is null for an unprobed segment — treat that as "assume audio" (most segments
      // have it) rather than silently skipping the audio lane.
      hasAudio: clip.hasAudio !== false,
    }),
  );
}
</script>

<template>
  <section class="flex h-full min-w-0 flex-1 flex-col gap-2 rounded-xl border border-white/5 bg-surface-900/80 p-2.5 shadow-panel">
    <!-- Folder breadcrumb toolbar -->
    <div class="flex items-center gap-2">
      <button
        class="flex h-7 w-8 items-center justify-center rounded-md border border-white/10 bg-surface-800 text-slate-400 transition hover:text-teal-300 disabled:opacity-40"
        :disabled="!openFolder"
        :title="openFolder ? 'Back to Video Library' : 'Up one level'"
        @click="back"
      >
        <ChevronLeftIcon class="h-4 w-4" />
      </button>
      <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/10 bg-surface-800 px-2 py-1">
        <FolderIcon class="h-4 w-4 shrink-0 text-emerald-400" />
        <span
          class="truncate font-mono text-xs"
          :class="gallery && !openFolder ? 'font-semibold text-emerald-300' : 'text-slate-200'"
        >
          {{ breadcrumb }}
        </span>
      </div>
      <button
        class="flex h-7 w-8 items-center justify-center rounded-md border border-white/10 bg-surface-800 text-slate-400 transition hover:text-teal-300"
        :class="{ 'animate-spin': loading }"
        title="Refresh"
        @click="refresh"
      >
        <ArrowPathIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- VIDEO LIBRARY — session folder grid -->
    <div v-if="!showingClips" class="min-h-0 flex-1 overflow-y-auto pr-0.5">
      <div class="grid grid-cols-3 gap-1">
        <button
          v-for="session in sessions"
          :key="session.folder"
          class="group relative flex flex-col items-center gap-0.5 rounded-lg p-2 transition hover:bg-white/5"
          :title="`${session.folder} — ${session.segmentCount} clips, ${formatSize(session.size)}${session.isActive ? ' · recording' : ''}`"
          @click="open(session.folder)"
        >
          <div class="relative">
            <FolderSolidIcon class="h-16 w-16 text-[#26304f] drop-shadow-sm transition group-hover:text-[#31406b]" />
            <span
              v-if="session.isActive"
              class="absolute right-2 top-4 flex items-center gap-0.5 rounded-full bg-rose-500/90 px-1 py-[1px] text-[7px] font-bold uppercase leading-none text-white"
            >
              <span class="h-1 w-1 rounded-full bg-white" />live
            </span>
          </div>
          <span class="w-full truncate text-center font-mono text-[11px] text-slate-200">
            {{ shortFolder(session.folder) }}
          </span>
        </button>
      </div>
      <div v-if="loading" class="mt-6 flex flex-col items-center gap-2 text-center text-xs text-slate-500">
        <ArrowPathIcon class="h-5 w-5 animate-spin text-teal-400" />
        Loading…
      </div>
      <p v-else-if="sessionsLoaded && !sessions.length" class="mt-6 text-center text-xs text-slate-600">
        No recording sessions found on the Emerald backend.
      </p>
    </div>

    <!-- CLIP GRID -->
    <template v-else>
      <input
        v-model="search"
        type="text"
        placeholder="Search clips…"
        class="w-full shrink-0 rounded-md border border-white/10 bg-surface-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
      />

      <!-- min-h-0 lets the flex child scroll; auto-rows-min keeps rows at natural height -->
      <div class="grid min-h-0 flex-1 grid-cols-2 auto-rows-min gap-2.5 overflow-y-auto pr-0.5">
        <button
          v-for="clip in filtered"
          :key="`${clip.sessionFolder}/${clip.fileName}`"
          class="group flex cursor-grab flex-col overflow-hidden rounded-lg border text-left transition active:cursor-grabbing"
          :class="programStore.clip?.url === clip.url
            ? 'border-teal-400 shadow-glow-teal'
            : 'border-white/5 bg-surface-850/70 hover:border-teal-500/40'"
          draggable="true"
          title="Click to load · drag onto the timeline to insert"
          @click="pick(clip)"
          @dragstart="onDragStart($event, clip)"
        >
          <div class="relative w-full shrink-0 overflow-hidden bg-black" style="height: 72px">
            <img
              :src="clip.thumbnailUrl ?? ''"
              :alt="clip.fileName"
              class="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
              @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
            />
            <FilmIcon class="pointer-events-none absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-white/20" />
            <span class="absolute right-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white/80">MP4</span>
          </div>
          <div class="space-y-0.5 px-1.5 py-1.5">
            <p class="truncate text-[11px] font-medium text-slate-200">{{ clip.fileName }}</p>
            <p class="font-mono text-[10px] text-slate-500">{{ formatSize(clip.size) }} · {{ formatCreated(clip.createdAt) }}</p>
          </div>
        </button>

        <div v-if="loading" class="col-span-2 mt-6 flex flex-col items-center gap-2 text-center text-xs text-slate-500">
          <ArrowPathIcon class="h-5 w-5 animate-spin text-teal-400" />
          Loading recorded clips…
        </div>
        <p v-else-if="loaded && !filtered.length" class="col-span-2 mt-6 text-center text-xs text-slate-600">
          {{ clips.length ? 'No clips match your search.' : 'No recorded clips found on the Emerald backend.' }}
        </p>
      </div>
    </template>
  </section>
</template>
