<script setup lang="ts">
/**
 * Browsable grid/list of project media assets, used standalone on the
 * Media Browser route and embeddable elsewhere (e.g. import dialogs).
 */
import AudioWaveformPreview from '@/components/media/AudioWaveformPreview.vue';
import { useProjectStore } from '@/stores/projectStore';
import type { MediaAsset } from '@/types/project';
import { FilmIcon, MusicalNoteIcon, PhotoIcon } from '@heroicons/vue/24/outline';
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
      <!-- A div rather than a <button>: the audio tiles now carry their own play control, and a
           button nested inside a button is invalid markup that browsers resolve by dropping one of
           them. Keyboard activation is wired up explicitly to keep the tile reachable. -->
      <div
        v-for="asset in visibleAssets"
        :key="asset.id"
        role="button"
        tabindex="0"
        class="group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-white/5 bg-surface-850/70 text-left transition hover:border-emerald-500/40 hover:shadow-glow focus:border-emerald-500/40 focus:outline-none"
        @click="emit('select', asset)"
        @keydown.enter.prevent="emit('select', asset)"
        @keydown.space.prevent="emit('select', asset)"
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
          <span class="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 font-mono text-[9px] text-emerald-300">
            {{ formatDuration(asset.duration) }}
          </span>
        </div>
        <div class="space-y-0.5 p-2">
          <p class="truncate text-xs font-medium text-slate-200">{{ asset.name }}</p>
          <p class="text-[10px] text-slate-500">{{ asset.resolution }} · {{ asset.codec }}</p>
          <p class="text-[10px] text-slate-600">{{ formatSize(asset.sizeBytes) }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
