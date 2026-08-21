<script setup lang="ts">
/**
 * Browsable grid/list of project media assets, used standalone on the
 * Media Browser route and embeddable elsewhere (e.g. import dialogs).
 */
import AudioWaveformPreview from '@/components/media/AudioWaveformPreview.vue';
import { useProjectStore } from '@/stores/projectStore';
import type { MediaAsset } from '@/types/project';
import {
  ArrowUpTrayIcon,
  ExclamationTriangleIcon,
  FilmIcon,
  MusicalNoteIcon,
  PhotoIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline';
import { computed, ref } from 'vue';

const projectStore = useProjectStore();
const search = ref('');

const emit = defineEmits<{
  select: [asset: MediaAsset];
}>();

const icons = { video: FilmIcon, audio: MusicalNoteIcon, image: PhotoIcon };

const visibleAssets = computed(() =>
  projectStore.mediaAssets.filter((a) => a.name.toLowerCase().includes(search.value.toLowerCase())),
);

/**
 * Previews are held by id rather than by index so a search that re-filters the grid doesn't leave
 * the registry pointing at whichever asset happens to now occupy that slot.
 */
type PreviewHandle = { stop: () => void };
const previews = ref<Record<string, PreviewHandle | null>>({});

function registerPreview(id: string, instance: unknown): void {
  previews.value[id] = (instance as PreviewHandle | null) ?? null;
}

/**
 * Only one audition at a time — two waveforms playing over each other tells an operator nothing
 * about either. Started previews announce themselves and every other one is stopped.
 */
function stopOtherPreviews(startedId: string): void {
  for (const [id, preview] of Object.entries(previews.value)) {
    if (id !== startedId) preview?.stop();
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// --- Import ------------------------------------------------------------------------------------

const fileInput = ref<HTMLInputElement | null>(null);
const fileDragOver = ref(false);

/**
 * Mirrors the extensions the backend accepts (see media.controller's ALLOWED_EXTENSIONS). The
 * picker's filter is only a convenience — the backend rejects anything else regardless — but a
 * dialog that greys out a file the app would refuse is friendlier than one that lets it through.
 */
const ACCEPT = 'video/*,audio/*,.mp4,.mov,.mkv,.m4v,.avi,.mxf,.webm,.ts,.wav,.mp3,.aac,.m4a,.flac,.ogg,.opus,.aiff,.aif';

function openFilePicker(): void {
  fileInput.value?.click();
}

async function onFilesChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // Cleared before awaiting, so choosing the same file again still fires a change event.
  input.value = '';
  if (files.length) await projectStore.importFiles(files);
}

/**
 * Only reacts to drags that actually carry files. Without this check the panel would light up for
 * an internal asset drag too, offering a drop that does nothing.
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
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) await projectStore.importFiles(files);
}

/**
 * Hands the asset to the timeline in the same shape ClipBrowser uses for recorded clips, so both
 * sources land through one drop handler in TimelineTrack rather than each needing its own.
 */
function onAssetDragStart(event: DragEvent, asset: MediaAsset): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(
    'application/x-emerald-clip',
    JSON.stringify({
      name: asset.name,
      url: asset.path,
      thumbnail: asset.thumbnail,
      durationSeconds: asset.duration,
      // Undefined on the mock assets, which predate probing — treated as "assume audio" by the
      // drop handler, matching how an unprobed recorded segment is treated.
      hasAudio: asset.hasAudio,
    }),
  );
}
</script>

<template>
  <section
    class="relative flex h-full flex-col gap-3 rounded-xl border bg-surface-900/80 p-4 shadow-panel transition-colors"
    :class="fileDragOver ? 'border-emerald-400/70' : 'border-white/5'"
    @dragover="onFileDragOver"
    @dragleave="fileDragOver = false"
    @drop="onFileDrop"
  >
    <header class="flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold uppercase tracking-widest text-slate-300">Media Browser</h2>
      <div class="flex items-center gap-2">
        <input
          v-model="search"
          type="text"
          placeholder="Search media…"
          class="w-56 rounded-md border border-white/10 bg-surface-800 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
        />
        <button
          class="flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:border-emerald-400 hover:bg-emerald-500/20"
          title="Import audio or video files into the project"
          @click="openFilePicker"
        >
          <ArrowUpTrayIcon class="h-4 w-4" />
          Import
        </button>
        <input
          ref="fileInput"
          type="file"
          multiple
          :accept="ACCEPT"
          class="hidden"
          @change="onFilesChosen"
        />
      </div>
    </header>

    <!-- Import progress. Sits above the grid so a long upload stays visible while the operator
         scrolls the library underneath it. -->
    <ul v-if="projectStore.imports.length" class="shrink-0 space-y-1.5">
      <li
        v-for="job in projectStore.imports"
        :key="job.id"
        class="rounded-md border px-2.5 py-1.5"
        :class="job.state === 'failed' ? 'border-rose-500/40 bg-rose-500/[0.07]' : 'border-white/10 bg-surface-850/70'"
      >
        <div class="flex items-center gap-2">
          <ExclamationTriangleIcon v-if="job.state === 'failed'" class="h-3.5 w-3.5 shrink-0 text-rose-400" />
          <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-slate-300">{{ job.name }}</span>
          <span class="shrink-0 font-mono text-[0.625rem] text-slate-500">
            {{ job.state === 'failed' ? 'failed' : job.state === 'probing' ? 'reading…' : `${Math.round(job.progress * 100)}%` }}
          </span>
          <button
            v-if="job.state === 'failed'"
            class="shrink-0 text-slate-500 transition hover:text-slate-300"
            title="Dismiss"
            @click="projectStore.dismissImport(job.id)"
          >
            <XMarkIcon class="h-3.5 w-3.5" />
          </button>
        </div>
        <p v-if="job.error" class="mt-0.5 text-[0.625rem] text-rose-300/80">{{ job.error }}</p>
        <div v-else class="mt-1 h-0.5 overflow-hidden rounded-full bg-white/10">
          <div
            class="h-full rounded-full bg-emerald-400 transition-all"
            :class="{ 'animate-pulse': job.state === 'probing' }"
            :style="{ width: `${Math.max(2, job.progress * 100)}%` }"
          />
        </div>
      </li>
    </ul>

    <div class="grid flex-1 grid-cols-2 items-start gap-3 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      <!-- A div rather than a <button>: the audio tiles now carry their own play control, and a
           button nested inside a button is invalid markup that browsers resolve by dropping one of
           them. Keyboard activation is wired up explicitly to keep the tile reachable. -->
      <div
        v-for="asset in visibleAssets"
        :key="asset.id"
        role="button"
        tabindex="0"
        draggable="true"
        title="Click to select · drag onto the timeline to insert"
        class="group flex cursor-grab flex-col overflow-hidden rounded-lg border border-white/5 bg-surface-850/70 text-left transition hover:border-emerald-500/40 hover:shadow-glow focus:border-emerald-500/40 focus:outline-none active:cursor-grabbing"
        @click="emit('select', asset)"
        @keydown.enter.prevent="emit('select', asset)"
        @keydown.space.prevent="emit('select', asset)"
        @dragstart="onAssetDragStart($event, asset)"
      >
        <div class="relative flex aspect-video items-center justify-center bg-black">
          <!-- Audio: the real waveform, auditionable in place. The music-note box it replaces said
               nothing about the material, which meant loading a take onto the timeline just to find
               out what was on it. -->
          <AudioWaveformPreview
            v-if="asset.type === 'audio'"
            :ref="(el) => registerPreview(asset.id, el)"
            :url="asset.path"
            class="px-2 py-3"
            color="#34d399"
            @play="stopOtherPreviews(asset.id)"
            @click.stop
          />
          <component v-else :is="icons[asset.type]" class="h-8 w-8 text-slate-700 transition group-hover:text-emerald-400" />
          <span class="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 font-mono text-[0.5625rem] text-emerald-300">
            {{ formatDuration(asset.duration) }}
          </span>
        </div>
        <div class="space-y-0.5 p-2">
          <p class="truncate text-xs font-medium text-slate-200">{{ asset.name }}</p>
          <p class="text-[0.625rem] text-slate-500">{{ asset.resolution }} · {{ asset.codec }}</p>
          <p class="text-[0.625rem] text-slate-600">{{ formatSize(asset.sizeBytes) }}</p>
        </div>
      </div>

      <p
        v-if="!visibleAssets.length"
        class="col-span-full mt-8 text-center text-xs text-slate-600"
      >
        {{ projectStore.mediaAssets.length
          ? 'No media matches your search.'
          : 'No media yet — use Import, or drop audio/video files here.' }}
      </p>
    </div>

    <!-- Shown only mid-drag, and pointer-events-none so it can't swallow the drop it is
         advertising — the section underneath is what handles it. -->
    <div
      v-if="fileDragOver"
      class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-emerald-400/70 bg-surface-950/80"
    >
      <div class="flex flex-col items-center gap-2 text-emerald-300">
        <ArrowUpTrayIcon class="h-7 w-7" />
        <span class="text-sm font-medium">Drop to import</span>
        <span class="text-[0.6875rem] text-emerald-400/70">Audio and video files</span>
      </div>
    </div>
  </section>
</template>
