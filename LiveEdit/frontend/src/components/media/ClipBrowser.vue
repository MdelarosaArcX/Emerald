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
 * Alongside the recorded sessions it also holds imported media — outside audio/video brought into
 * the project (see the backend's media.controller). Imports live in their own pinned folder rather
 * than mixed into a session, because they didn't come from a recording and belong to the project
 * as a whole.
 *
 * Either way, clicking a clip loads it into the center Program monitor (via programStore) and
 * dragging one onto the timeline inserts it.
 */
import { api } from '@/services/api';
import {
  fetchRecordedClips,
  fetchRecordingSessions,
  fetchSessionClips,
  type RecordedClip,
  type RecordingSession,
} from '@/services/emeraldPreview';
import { useProgramStore } from '@/stores/programStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import type { MediaAsset } from '@/types/project';
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  ChevronLeftIcon,
  ExclamationTriangleIcon,
  FilmIcon,
  FolderIcon,
  MusicalNoteIcon,
  PhotoIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline';
import { FolderIcon as FolderSolidIcon } from '@heroicons/vue/24/solid';
import { computed, onMounted, ref } from 'vue';

const props = defineProps<{ gallery?: boolean }>();

const programStore = useProgramStore();
const projectStore = useProjectStore();
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

/**
 * null while the gallery is showing the session list; a folder name once one is opened.
 * IMPORTED_FOLDER is a pinned pseudo-folder — imports aren't a recording session, but presenting
 * them as one more folder means the existing navigation, breadcrumb and back button all apply
 * unchanged instead of needing a parallel mode.
 */
const IMPORTED_FOLDER = '__imported__';
const openFolder = ref<string | null>(null);

const importedAssets = ref<MediaAsset[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const fileDragOver = ref(false);

/** Mirrors the backend's ALLOWED_EXTENSIONS (media.controller) — the dialog filter only. */
const ACCEPT = 'video/*,audio/*,.mp4,.mov,.mkv,.m4v,.avi,.mxf,.webm,.ts,.wav,.mp3,.aac,.m4a,.flac,.ogg,.opus,.aiff,.aif';

/** True when the imported pseudo-folder is what's open. */
const showingImports = computed(() => openFolder.value === IMPORTED_FOLDER);

const filteredImports = computed(() =>
  importedAssets.value.filter((a) => a.name.toLowerCase().includes(search.value.toLowerCase())),
);

const importIcons = { video: FilmIcon, audio: MusicalNoteIcon, image: PhotoIcon };

onMounted(async () => {
  // The flat layout has no library level to show, so it goes straight to the active session's
  // clips; the gallery starts at the folder grid and loads clips only once one is opened.
  await loadImports();
  if (props.gallery) await loadSessions();
  else await loadActiveSessionClips();
});

async function loadImports(): Promise<void> {
  try {
    importedAssets.value = await api.listImportedMedia();
  } catch {
    // A backend that can't list imports shouldn't stop the recorded-clip browser from working —
    // the folder just shows as empty.
    importedAssets.value = [];
  }
}

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

  // The imported folder is served from its own endpoint, not from a recording session.
  if (folder === IMPORTED_FOLDER) {
    loading.value = true;
    try {
      await loadImports();
      loaded.value = true;
    } finally {
      loading.value = false;
    }
    return;
  }

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
  // In the flat layout there is no folder level to return to, so leaving a folder means going
  // back to the active session's clips rather than to an empty grid.
  if (!props.gallery) void loadActiveSessionClips();
}

function refresh(): void {
  if (openFolder.value === IMPORTED_FOLDER) void loadImports();
  else if (!props.gallery) void loadActiveSessionClips();
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
  if (showingImports.value) return 'Imported Media';
  if (props.gallery) return openFolder.value ?? 'Video Library';
  return clips.value[0]?.sessionFolder ?? 'Recordings';
});

/** Whether a grid (clips or imports) is the thing on screen right now. */
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

// --- Imported media ------------------------------------------------------------------------

function openFilePicker(): void {
  fileInput.value?.click();
}

async function onFilesChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // Cleared before awaiting so choosing the same file again still fires a change event.
  input.value = '';
  await runImport(files);
}

/**
 * Only reacts to drags carrying OS files. Without this the panel would light up for a clip being
 * dragged out of it towards the timeline, offering a drop that does nothing.
 */
function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function onFileDragOver(event: DragEvent): void {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  fileDragOver.value = true;
}

async function onFileDrop(event: DragEvent): Promise<void> {
  fileDragOver.value = false;
  if (!isFileDrag(event)) return;
  event.preventDefault();
  await runImport(Array.from(event.dataTransfer?.files ?? []));
}

/**
 * Imports files and shows the result. The imported folder is opened on success so the new material
 * is on screen where it landed — an import that silently filed things away somewhere the operator
 * isn't looking reads as an import that did nothing.
 */
async function runImport(files: File[]): Promise<void> {
  if (!files.length) return;
  const imported = await projectStore.importFiles(files);
  await loadImports();
  if (imported.length) {
    openFolder.value = IMPORTED_FOLDER;
    search.value = '';
    loaded.value = true;
  }
}

/** Imported assets reuse the recorded-clip path by presenting themselves in the same shape. */
function asRecordedClip(asset: MediaAsset): RecordedClip {
  return {
    fileName: asset.name,
    sessionFolder: 'Imported',
    kind: 'mp4',
    url: asset.path,
    thumbnailUrl: asset.thumbnail ?? null,
    size: asset.sizeBytes,
    createdAt: asset.createdAt,
    durationSeconds: asset.duration || null,
    hasAudio: asset.hasAudio ?? null,
    // Imported media has no place in the recording's timebase — it was never captured by this
    // system, so there is no recorded timecode to position it at. It lands where it is dropped.
    startTimecode: null,
    frameRate: null,
  };
}

function pickImport(asset: MediaAsset): void {
  pick(asRecordedClip(asset));
}

function onImportDragStart(event: DragEvent, asset: MediaAsset): void {
  onDragStart(event, asRecordedClip(asset));
}
</script>

<template>
  <section
    class="relative flex h-full min-w-0 flex-1 flex-col gap-2 rounded-xl border bg-surface-900/80 p-2.5 shadow-panel transition-colors"
    :class="fileDragOver ? 'border-emerald-400/70' : 'border-white/5'"
    @dragover="onFileDragOver"
    @dragleave="fileDragOver = false"
    @drop="onFileDrop"
  >
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
        class="flex h-7 w-8 shrink-0 items-center justify-center rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 transition hover:border-emerald-400 hover:bg-emerald-500/20"
        title="Import audio or video files into the project"
        @click="openFilePicker"
      >
        <ArrowUpTrayIcon class="h-4 w-4" />
      </button>
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="ACCEPT"
        class="hidden"
        @change="onFilesChosen"
      />
      <button
        class="flex h-7 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-surface-800 text-slate-400 transition hover:text-teal-300"
        :class="{ 'animate-spin': loading }"
        title="Refresh"
        @click="refresh"
      >
        <ArrowPathIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- Import progress, above whichever grid is showing so a long upload stays visible. -->
    <ul v-if="projectStore.imports.length" class="shrink-0 space-y-1">
      <li
        v-for="job in projectStore.imports"
        :key="job.id"
        class="rounded-md border px-2 py-1"
        :class="job.state === 'failed' ? 'border-rose-500/40 bg-rose-500/[0.07]' : 'border-white/10 bg-surface-850/70'"
      >
        <div class="flex items-center gap-1.5">
          <ExclamationTriangleIcon v-if="job.state === 'failed'" class="h-3 w-3 shrink-0 text-rose-400" />
          <span class="min-w-0 flex-1 truncate text-[0.625rem] text-slate-300">{{ job.name }}</span>
          <span class="shrink-0 font-mono text-[0.5625rem] text-slate-500">
            {{ job.state === 'failed' ? 'failed' : job.state === 'probing' ? 'reading…' : `${Math.round(job.progress * 100)}%` }}
          </span>
          <button
            v-if="job.state === 'failed'"
            class="shrink-0 text-slate-500 transition hover:text-slate-300"
            title="Dismiss"
            @click="projectStore.dismissImport(job.id)"
          >
            <XMarkIcon class="h-3 w-3" />
          </button>
        </div>
        <p v-if="job.error" class="mt-0.5 text-[0.5625rem] leading-tight text-rose-300/80">{{ job.error }}</p>
        <div v-else class="mt-1 h-0.5 overflow-hidden rounded-full bg-white/10">
          <div
            class="h-full rounded-full bg-emerald-400 transition-all"
            :class="{ 'animate-pulse': job.state === 'probing' }"
            :style="{ width: `${Math.max(2, job.progress * 100)}%` }"
          />
        </div>
      </li>
    </ul>

    <!-- VIDEO LIBRARY — session folder grid -->
    <div v-if="!showingClips" class="min-h-0 flex-1 overflow-y-auto pr-0.5">
      <div class="grid grid-cols-3 gap-1">
        <!-- Pinned first: imports belong to the project rather than to any recording session, and
             are what an operator has most likely just added. -->
        <button
          class="group relative flex flex-col items-center gap-0.5 rounded-lg p-2 transition hover:bg-white/5"
          :title="`Imported media — ${importedAssets.length} file${importedAssets.length === 1 ? '' : 's'}`"
          @click="open(IMPORTED_FOLDER)"
        >
          <div class="relative">
            <FolderSolidIcon class="h-16 w-16 text-[#1f4438] drop-shadow-sm transition group-hover:text-[#2a5c4b]" />
            <ArrowUpTrayIcon class="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-[35%] text-emerald-300/80" />
          </div>
          <span class="w-full truncate text-center font-mono text-[0.6875rem] text-emerald-300">Imported</span>
        </button>
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
              class="absolute right-2 top-4 flex items-center gap-0.5 rounded-full bg-rose-500/90 px-1 py-[1px] text-[0.4375rem] font-bold uppercase leading-none text-white"
            >
              <span class="h-1 w-1 rounded-full bg-white" />live
            </span>
          </div>
          <span class="w-full truncate text-center font-mono text-[0.6875rem] text-slate-200">
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
      <div class="flex shrink-0 items-center gap-1.5">
        <input
          v-model="search"
          type="text"
          :placeholder="showingImports ? 'Search imported media…' : 'Search clips…'"
          class="min-w-0 flex-1 rounded-md border border-white/10 bg-surface-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
        />
        <!-- The flat layout has no folder grid, so this is its only way into the imported folder.
             The gallery reaches it through the pinned tile instead. -->
        <button
          v-if="!gallery && !showingImports"
          class="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-surface-800 px-2 py-1.5 text-[0.625rem] font-medium text-slate-300 transition hover:border-emerald-500/40 hover:text-emerald-300"
          title="Show imported media"
          @click="open(IMPORTED_FOLDER)"
        >
          Imported
          <span v-if="importedAssets.length" class="font-mono text-emerald-400">{{ importedAssets.length }}</span>
        </button>
      </div>

      <!-- IMPORTED MEDIA GRID -->
      <div
        v-if="showingImports"
        class="grid min-h-0 flex-1 grid-cols-2 auto-rows-min gap-2.5 overflow-y-auto pr-0.5"
      >
        <button
          v-for="asset in filteredImports"
          :key="asset.id"
          class="group flex cursor-grab flex-col overflow-hidden rounded-lg border text-left transition active:cursor-grabbing"
          :class="programStore.clip?.url === asset.path
            ? 'border-teal-400 shadow-glow-teal'
            : 'border-white/5 bg-surface-850/70 hover:border-teal-500/40'"
          draggable="true"
          title="Click to load · drag onto the timeline to insert"
          @click="pickImport(asset)"
          @dragstart="onImportDragStart($event, asset)"
        >
          <div class="relative flex w-full shrink-0 items-center justify-center overflow-hidden bg-black" style="height: 4.5rem">
            <img
              v-if="asset.thumbnail"
              :src="asset.thumbnail"
              :alt="asset.name"
              class="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
            />
            <component :is="importIcons[asset.type]" class="h-6 w-6 text-white/25" />
            <span class="absolute right-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-emerald-300/90">
              {{ asset.type }}
            </span>
          </div>
          <div class="space-y-0.5 px-1.5 py-1.5">
            <p class="truncate text-[0.6875rem] font-medium text-slate-200">{{ asset.name }}</p>
            <p class="font-mono text-[0.625rem] text-slate-500">{{ formatSize(asset.sizeBytes) }} · {{ asset.resolution }}</p>
          </div>
        </button>

        <div v-if="loading" class="col-span-2 mt-6 flex flex-col items-center gap-2 text-center text-xs text-slate-500">
          <ArrowPathIcon class="h-5 w-5 animate-spin text-teal-400" />
          Loading imported media…
        </div>
        <p v-else-if="!filteredImports.length" class="col-span-2 mt-6 text-center text-xs text-slate-600">
          {{ importedAssets.length
            ? 'No imported media matches your search.'
            : 'Nothing imported yet — use the Import button, or drop audio/video files here.' }}
        </p>
      </div>

      <!-- min-h-0 lets the flex child scroll; auto-rows-min keeps rows at natural height -->
      <div v-else class="grid min-h-0 flex-1 grid-cols-2 auto-rows-min gap-2.5 overflow-y-auto pr-0.5">
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
          <div class="relative w-full shrink-0 overflow-hidden bg-black" style="height: 4.5rem">
            <img
              :src="clip.thumbnailUrl ?? ''"
              :alt="clip.fileName"
              class="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
              @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
            />
            <FilmIcon class="pointer-events-none absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-white/20" />
            <span class="absolute right-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-white/80">MP4</span>
          </div>
          <div class="space-y-0.5 px-1.5 py-1.5">
            <p class="truncate text-[0.6875rem] font-medium text-slate-200">{{ clip.fileName }}</p>
            <p class="font-mono text-[0.625rem] text-slate-500">{{ formatSize(clip.size) }} · {{ formatCreated(clip.createdAt) }}</p>
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

    <!-- pointer-events-none so it can't swallow the drop it is advertising — the section
         underneath handles it. -->
    <div
      v-if="fileDragOver"
      class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-emerald-400/70 bg-surface-950/85"
    >
      <div class="flex flex-col items-center gap-1.5 text-emerald-300">
        <ArrowUpTrayIcon class="h-6 w-6" />
        <span class="text-xs font-medium">Drop to import</span>
        <span class="text-[0.625rem] text-emerald-400/70">Audio and video files</span>
      </div>
    </div>
  </section>
</template>
