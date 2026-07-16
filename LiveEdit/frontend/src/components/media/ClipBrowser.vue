<script setup lang="ts">
/**
 * Saved-clips directory browser shown in the left deck's "Media Browser" tab.
 * Lists the Emerald backend's recorded clips (H.264 segments) as a two-column
 * thumbnail grid; clicking a clip loads it into the center Program monitor for
 * viewing/editing (via programStore).
 */
import { fetchRecordedClips, type RecordedClip } from '@/services/emeraldPreview';
import { useProgramStore } from '@/stores/programStore';
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  FilmIcon,
  FolderIcon,
} from '@heroicons/vue/24/outline';
import { computed, onMounted, ref } from 'vue';

const programStore = useProgramStore();

const clips = ref<RecordedClip[]>([]);
const loading = ref(false);
const loaded = ref(false);
const search = ref('');

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  try {
    clips.value = await fetchRecordedClips();
    loaded.value = true;
  } finally {
    loading.value = false;
  }
}

const filtered = computed(() =>
  clips.value.filter((c) => c.fileName.toLowerCase().includes(search.value.toLowerCase())),
);

/** Most recent session folder, shown in the breadcrumb (e.g. "emerald071520262238"). */
const folderName = computed(() => clips.value[0]?.sessionFolder ?? 'Recordings');

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
}
</script>

<template>
  <section class="flex h-full min-w-0 flex-1 flex-col gap-2 rounded-xl border border-white/5 bg-surface-900/80 p-2.5 shadow-panel">
    <!-- Folder breadcrumb toolbar -->
    <div class="flex items-center gap-2">
      <button
        class="flex h-7 w-8 items-center justify-center rounded-md border border-white/10 bg-surface-800 text-slate-400 transition hover:text-teal-300"
        title="Up one level"
      >
        <ChevronLeftIcon class="h-4 w-4" />
      </button>
      <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/10 bg-surface-800 px-2 py-1">
        <FolderIcon class="h-4 w-4 shrink-0 text-emerald-400" />
        <span class="truncate font-mono text-xs text-slate-200">{{ folderName }}</span>
      </div>
      <button
        class="flex h-7 w-8 items-center justify-center rounded-md border border-white/10 bg-surface-800 text-slate-400 transition hover:text-teal-300"
        :class="{ 'animate-spin': loading }"
        title="Refresh"
        @click="load"
      >
        <ArrowPathIcon class="h-4 w-4" />
      </button>
    </div>

    <input
      v-model="search"
      type="text"
      placeholder="Search clips…"
      class="w-full rounded-md border border-white/10 bg-surface-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
    />

    <!-- Clip grid (min-h-0 lets the flex child scroll; auto-rows-min keeps rows at natural height) -->
    <div class="grid min-h-0 flex-1 grid-cols-2 auto-rows-min gap-2.5 overflow-y-auto pr-0.5">
      <button
        v-for="clip in filtered"
        :key="`${clip.sessionFolder}/${clip.fileName}`"
        class="group flex flex-col overflow-hidden rounded-lg border text-left transition"
        :class="programStore.clip?.url === clip.url
          ? 'border-teal-400 shadow-glow-teal'
          : 'border-white/5 bg-surface-850/70 hover:border-teal-500/40'"
        @click="pick(clip)"
      >
        <div class="relative w-full shrink-0 overflow-hidden bg-black" style="height: 72px">
          <img
            :src="clip.thumbnailUrl"
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
  </section>
</template>
