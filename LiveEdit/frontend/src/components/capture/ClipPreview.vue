<script setup lang="ts">
/**
 * Live Edit mode's left-column preview. This is PLAYBACK of the clip currently selected in the
 * Video Library below (programStore.clip) — not the live capture feed. It replaces CapturePreview
 * in that column: the operator is cutting recorded material here, so the useful thing to see is
 * the clip they are about to edit, with its media details underneath.
 *
 * The details block is the "Browse Media" panel: media path, title, duration/rate, and the proxy
 * vs. hi-res format pair, so the operator can tell at a glance which rendition they are looking at.
 */
import { useProgramStore } from '@/stores/programStore';
import { useTimecode } from '@/composables/useTimecode';
import {
  ArrowPathIcon,
  ArrowsPointingOutIcon,
  BackwardIcon,
  FilmIcon,
  ForwardIcon,
  GlobeAltIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/vue/24/outline';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const programStore = useProgramStore();

const frameRef = ref<HTMLElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const isPlaying = ref(false);
const currentSeconds = ref(0);
const durationSeconds = ref(0);

const clip = computed(() => programStore.clip);
const fps = computed(() => programStore.fps || 25);
const { framesToTimecode } = useTimecode(() => fps.value);

/** Elapsed position as a broadcast HH:MM:SS:FF readout (frames 00..24 at 25 fps). */
const positionTimecode = computed(() => framesToTimecode(Math.round(currentSeconds.value * fps.value)));
const durationTimecode = computed(() => framesToTimecode(Math.round(durationSeconds.value * fps.value)));

// Source is applied imperatively rather than via :src. Binding it would make Vue set the attribute
// during patch, before the element's own load state has been reset, and a mid-flight src swap on a
// <video> that is still fetching the previous clip leaves it wedged with a stale buffer.
function applySource(url: string): void {
  const v = videoRef.value;
  if (!v) return;
  if (url) {
    v.src = url;
    v.load();
  } else {
    v.removeAttribute('src');
    v.load();
  }
}

// Applied from BOTH the watcher and onMounted, and deliberately so. Toggling Live Edit mode
// remounts this deck, so a clip picked beforehand is already in the store when setup runs — at
// which point videoRef is still null and the watcher has nothing to write to. Without the mounted
// pass that clip never gets a source and the player comes up blank.
watch(
  () => clip.value?.url ?? '',
  (url) => {
    isPlaying.value = false;
    currentSeconds.value = 0;
    durationSeconds.value = 0;
    applySource(url);
  },
);
onMounted(() => applySource(clip.value?.url ?? ''));

/** Start playback, surviving the browser autoplay policy (retry muted, then restore audio). */
function playVideo(v: HTMLVideoElement): void {
  v.play().catch(() => {
    v.muted = true;
    v.play()
      .then(() => {
        v.muted = false;
      })
      .catch(() => {});
  });
}

function togglePlay(): void {
  const v = videoRef.value;
  if (!v || !clip.value) return;
  if (v.paused) playVideo(v);
  else v.pause();
}

function stop(): void {
  const v = videoRef.value;
  if (!v) return;
  v.pause();
  v.currentTime = 0;
}

function reload(): void {
  const v = videoRef.value;
  if (!v || !clip.value) return;
  v.load();
}

function skip(seconds: number): void {
  const v = videoRef.value;
  if (!v || !Number.isFinite(v.duration)) return;
  v.currentTime = Math.min(Math.max(0, v.currentTime + seconds), v.duration);
}

function onSeek(event: Event): void {
  const v = videoRef.value;
  if (!v || !Number.isFinite(v.duration)) return;
  v.currentTime = Number((event.target as HTMLInputElement).value);
}

function requestFullscreen(): void {
  frameRef.value?.requestFullscreen?.();
}

/**
 * Directory the clip is served from, e.g. "/recordings/emerald080520262002/". This is the served
 * URL path, not Emerald's own disk path — the backend never reports the latter, and showing a
 * fabricated local path would be worse than showing the real one media actually loads from.
 */
const mediaPath = computed(() => {
  const url = clip.value?.url;
  if (!url) return '—';
  try {
    return new URL(url).pathname.replace(/[^/]+$/, '');
  } catch {
    return url.replace(/[^/]+$/, '');
  }
});

const sizeLabel = computed(() => {
  const bytes = clip.value?.size ?? 0;
  if (!bytes) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
});

onBeforeUnmount(() => videoRef.value?.pause());
</script>

<template>
  <section class="flex h-full min-w-0 flex-1 flex-col gap-2 rounded-xl border border-white/5 bg-surface-900/80 p-2.5 shadow-panel">
    <!-- Preview -->
    <div class="shrink-0 overflow-hidden rounded-lg border border-white/5 bg-black">
      <div class="flex items-center justify-between bg-gradient-to-r from-teal-500/80 to-emerald-600/70 px-2 py-0.5">
        <span class="truncate font-mono text-[11px] font-semibold tracking-wider text-black/90">
          {{ clip?.fileName ?? 'Clip Preview' }}
        </span>
        <span class="shrink-0 font-mono text-[10px] tracking-wider text-black/80">{{ positionTimecode }}</span>
      </div>
      <div ref="frameRef" class="relative aspect-video max-h-[150px] overflow-hidden bg-black">
        <video
          v-show="clip"
          ref="videoRef"
          class="absolute inset-0 h-full w-full object-contain"
          :poster="clip?.thumbnailUrl ?? undefined"
          preload="metadata"
          playsinline
          @play="isPlaying = true"
          @pause="isPlaying = false"
          @timeupdate="currentSeconds = videoRef?.currentTime ?? 0"
          @loadedmetadata="durationSeconds = Number.isFinite(videoRef?.duration) ? (videoRef?.duration ?? 0) : 0"
        />
        <div v-if="!clip" class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-[11px] text-slate-600">
          <FilmIcon class="h-6 w-6 text-white/15" />
          Select a clip below to preview it
        </div>
      </div>
    </div>

    <!-- Scrub bar -->
    <input
      type="range"
      min="0"
      :max="durationSeconds || 0"
      step="0.04"
      :value="currentSeconds"
      class="h-1 w-full shrink-0 cursor-pointer appearance-none rounded-full bg-white/10 accent-emerald-400 disabled:opacity-40"
      :disabled="!clip"
      title="Seek"
      @input="onSeek"
    />

    <!-- Transport -->
    <div class="flex shrink-0 items-center justify-between rounded-lg border border-white/5 bg-surface-850/70 px-2 py-1.5">
      <button
        class="rounded p-1 transition disabled:opacity-30"
        :class="isPlaying ? 'text-emerald-300' : 'text-slate-400 hover:text-emerald-300'"
        :title="isPlaying ? 'Pause' : 'Play'"
        :disabled="!clip"
        @click="togglePlay"
      >
        <PauseIcon v-if="isPlaying" class="h-4 w-4" />
        <PlayIcon v-else class="h-4 w-4" />
      </button>
      <button class="rounded p-1 text-slate-400 transition hover:text-rose-400 disabled:opacity-30" title="Stop" :disabled="!clip" @click="stop">
        <StopIcon class="h-4 w-4" />
      </button>
      <button class="rounded p-1 text-slate-400 transition hover:text-teal-300 disabled:opacity-30" title="Reload clip" :disabled="!clip" @click="reload">
        <ArrowPathIcon class="h-4 w-4" />
      </button>
      <button class="rounded p-1 text-slate-400 transition hover:text-emerald-300 disabled:opacity-30" title="Back 10s" :disabled="!clip" @click="skip(-10)">
        <BackwardIcon class="h-4 w-4" />
      </button>
      <button class="rounded p-1 text-slate-400 transition hover:text-emerald-300 disabled:opacity-30" title="Forward 10s" :disabled="!clip" @click="skip(10)">
        <ForwardIcon class="h-4 w-4" />
      </button>
      <span class="flex h-5 w-6 items-center justify-center rounded border border-emerald-400/40 bg-emerald-400/10 font-mono text-[9px] font-bold text-emerald-300">VU</span>
      <button class="rounded p-1 text-slate-400 transition hover:text-emerald-300" title="Fullscreen" @click="requestFullscreen">
        <ArrowsPointingOutIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- BROWSE MEDIA -->
    <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-white/5 bg-surface-850/60 p-3 text-xs">
      <h3 class="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-slate-300">
        <GlobeAltIcon class="h-4 w-4 text-teal-400" />
        Browse Media
      </h3>
      <dl class="grid grid-cols-[104px_1fr] gap-x-3 gap-y-2.5">
        <dt class="text-slate-500">Media path</dt>
        <dd class="truncate font-mono text-slate-200" :title="mediaPath">{{ mediaPath }}</dd>

        <dt class="text-slate-500">Title</dt>
        <dd class="truncate text-slate-200" :title="clip?.fileName">{{ clip?.fileName ?? '—' }}</dd>

        <dt class="text-slate-500">Description</dt>
        <dd class="truncate text-slate-200" :title="clip?.sessionFolder">
          {{ clip ? `Recorded segment · ${clip.sessionFolder}` : '—' }}
        </dd>

        <dt class="text-slate-500">Size</dt>
        <dd class="font-mono text-slate-200">{{ sizeLabel }}</dd>

        <dt class="self-start text-slate-500">Duration</dt>
        <dd class="text-right font-mono text-slate-200">
          <div>{{ durationTimecode }}</div>
          <div class="text-slate-400">{{ fps }} FPS</div>
        </dd>

        <dt class="text-slate-500">Format <span class="text-slate-600">(Proxy)</span></dt>
        <dd class="font-mono text-slate-200">
          MP4 <span class="px-1 text-slate-600">|</span> H.264 <span class="px-1 text-slate-600">|</span> AAC
        </dd>

        <dt class="text-slate-500">Format <span class="text-slate-600">(HiRes)</span></dt>
        <dd class="font-mono text-slate-200">
          MOV <span class="px-1 text-slate-600">|</span> ProRes 422 <span class="px-1 text-slate-600">|</span> AAC
        </dd>
      </dl>
    </div>
  </section>
</template>
