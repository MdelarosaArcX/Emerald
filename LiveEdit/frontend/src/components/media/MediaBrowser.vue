<script setup lang="ts">
/**
 * Browsable grid/list of project media assets, used standalone on the
 * Media Browser route and embeddable elsewhere (e.g. import dialogs).
 */
import { useProjectStore } from '@/stores/projectStore';
import type { MediaAsset } from '@/types/project';
import { FilmIcon, MusicalNoteIcon, PhotoIcon } from '@heroicons/vue/24/outline';
import { ref } from 'vue';

const projectStore = useProjectStore();
const search = ref('');

const emit = defineEmits<{
  select: [asset: MediaAsset];
}>();

const icons = { video: FilmIcon, audio: MusicalNoteIcon, image: PhotoIcon };

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
</script>

<template>
  <section class="flex h-full flex-col gap-3 rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel">
    <header class="flex items-center justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-widest text-slate-300">Media Browser</h2>
      <input
        v-model="search"
        type="text"
        placeholder="Search media…"
        class="w-56 rounded-md border border-white/10 bg-surface-800 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
      />
    </header>

    <div class="grid flex-1 grid-cols-2 items-start gap-3 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      <button
        v-for="asset in projectStore.mediaAssets.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))"
        :key="asset.id"
        class="group flex flex-col overflow-hidden rounded-lg border border-white/5 bg-surface-850/70 text-left transition hover:border-emerald-500/40 hover:shadow-glow"
        @click="emit('select', asset)"
      >
        <div class="relative flex aspect-video items-center justify-center bg-black">
          <component :is="icons[asset.type]" class="h-8 w-8 text-slate-700 transition group-hover:text-emerald-400" />
          <span class="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 font-mono text-[9px] text-emerald-300">
            {{ formatDuration(asset.duration) }}
          </span>
        </div>
        <div class="space-y-0.5 p-2">
          <p class="truncate text-xs font-medium text-slate-200">{{ asset.name }}</p>
          <p class="text-[10px] text-slate-500">{{ asset.resolution }} · {{ asset.codec }}</p>
          <p class="text-[10px] text-slate-600">{{ formatSize(asset.sizeBytes) }}</p>
        </div>
      </button>
    </div>
  </section>
</template>
