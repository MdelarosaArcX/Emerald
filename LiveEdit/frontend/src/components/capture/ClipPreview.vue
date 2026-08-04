<script setup lang="ts">
/**
 * Live Edit mode left-column preview. Unlike CapturePreview (which embeds the live capture feed),
 * this is a plain PLAYBACK of the clip currently selected in the media browser below
 * (programStore.clip). It plays a lightweight backend proxy of the recorded segment — the raw
 * segments are large non-faststart 4K files — showing the clip's thumbnail as a poster meanwhile.
 */
import { requestProxy } from '@/services/render';
import { useProgramStore } from '@/stores/programStore';
import { ArrowsPointingOutIcon, FilmIcon, GlobeAltIcon, PauseIcon, PlayIcon } from '@heroicons/vue/24/outline';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const programStore = useProgramStore();
const fps = computed(() => programStore.fps || 25);

const frameRef = ref<HTMLElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const proxyUrl = ref('');
const proxyLoading = ref(false);
const isPlaying = ref(false);
const currentTime = ref(0);
const duration = ref(0);

const clip = computed(() => programStore.clip);
const source = computed(() => clip.value?.url ?? '');
// The proxy URL is a relative path ("/proxies/x.mp4") served by our own backend — a valid video
// source even though it isn't absolute. (Testing it against /^https?:/ was a real bug elsewhere.)
const hasVideo = computed(() => proxyUrl.value.length > 0);

let token = 0;
watch(
  source,
  async (src) => {
    proxyUrl.value = '';
    isPlaying.value = false;
    currentTime.value = 0;
    duration.value = 0;
    if (!/^https?:/i.test(src)) {
      proxyLoading.value = false;
      return;
    }
    const t = ++token;
    proxyLoading.value = true;
    const url = await requestProxy(src);
    if (t !== token) return; // superseded by a newer selection
    proxyLoading.value = false;
    proxyUrl.value = url ?? '';
  },
  { immediate: true },
);

watch(proxyUrl, (url) => {
  const v = videoRef.value;
  if (!v) return;
  if (url) {
    v.src = url;
    v.load();
  } else {
    v.removeAttribute('src');
    v.load();
  }
});

/** Start playback, surviving the browser autoplay policy (retry muted, then restore audio). */
function playVideo(v: HTMLVideoElement): void {
  const p = v.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      v.muted = true;
      v.play()
        .then(() => {
          v.muted = false;
        })
        .catch(() => {});
    });
  }
}

function togglePlay(): void {
  const v = videoRef.value;
  if (!v || !hasVideo.value) return;
  if (v.paused) playVideo(v);
  else v.pause();
}

function onSeek(event: Event): void {
  const v = videoRef.value;
  if (!v || !Number.isFinite(v.duration)) return;
  v.currentTime = Number((event.target as HTMLInputElement).value);
}

function requestFullscreen(): void {
  frameRef.value?.requestFullscreen?.();
}

function pad(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}
function clock(seconds: number): string {
  const s = Number.isFinite(seconds) ? seconds : 0;
  return `${pad(s / 60)}:${pad(s % 60)}`;
}
/** HH:MM:SS:FF timecode for the details panel. */
function timecode(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const ff = Math.round((s - Math.floor(s)) * fps.value);
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}:${pad(ff)}`;
}

/** Directory portion of the clip's served URL, e.g. "/recordings/062226/". */
const mediaPath = computed(() => {
  const u = clip.value?.url;
  if (!u) return '—';
  try {
    return new URL(u).pathname.replace(/[^/]+$/, '');
  } catch {
    return u.replace(/[^/]+$/, '');
  }
});

onBeforeUnmount(() => videoRef.value?.pause());
</script>

<template>
  <section class="flex h-full min-w-0 flex-1 flex-col gap-2 rounded-xl border border-white/5 bg-surface-900/80 p-2.5 shadow-panel">
    <!-- Preview header + video -->
    <div class="shrink-0 overflow-hidden rounded-lg border border-white/5 bg-black">
      <div class="flex items-center justify-between bg-gradient-to-r from-teal-500/80 to-emerald-600/70 px-2 py-0.5">
        <span class="truncate font-mono text-[11px] font-semibold tracking-wider text-black/90">{{ clip?.fileName ?? 'Clip Preview' }}</span>
        <span class="font-mono text-[10px] tracking-wider text-black/80">{{ clock(currentTime) }} / {{ clock(duration) }}</span>
      </div>
      <!-- Compact preview so the Browse Media details below get the room to expand. -->
      <div ref="frameRef" class="relative aspect-video max-h-[150px] overflow-hidden bg-black">
        <!-- Thumbnail poster while no video / no selection -->
        <div
          v-if="clip?.thumbnailUrl"
          v-show="!hasVideo"
          class="absolute inset-0 bg-contain bg-center bg-no-repeat"
          :style="{ backgroundImage: `url(${clip.thumbnailUrl})` }"
        />
        <video
          v-show="hasVideo"
          ref="videoRef"
          class="absolute inset-0 h-full w-full object-contain"
          :poster="clip?.thumbnailUrl"
          playsinline
          @play="isPlaying = true"
          @pause="isPlaying = false"
          @timeupdate="currentTime = videoRef?.currentTime ?? 0"
          @loadedmetadata="duration = videoRef?.duration ?? 0"
        />
        <div v-if="!clip" class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-[11px] text-slate-600">
          <FilmIcon class="h-6 w-6 text-white/15" />
          Select a clip below to preview it
        </div>
        <div v-if="proxyLoading && !hasVideo && clip" class="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-[10px] text-slate-200 backdrop-blur">
          Preparing preview…
        </div>
      </div>
    </div>

    <!-- Transport row -->
    <div class="flex shrink-0 items-center gap-2 rounded-lg border border-white/5 bg-surface-850/70 px-2 py-1.5">
      <button
        class="rounded p-1 transition"
        :class="isPlaying ? 'text-emerald-300' : 'text-slate-400 hover:text-emerald-300'"
        :title="isPlaying ? 'Pause' : 'Play'"
        :disabled="!hasVideo"
        @click="togglePlay"
      >
        <PauseIcon v-if="isPlaying" class="h-4 w-4" />
        <PlayIcon v-else class="h-4 w-4" />
      </button>
      <input
        type="range"
        min="0"
        :max="duration || 0"
        step="0.1"
        :value="currentTime"
        class="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-emerald-400 disabled:opacity-40"
        :disabled="!hasVideo"
        title="Seek"
        @input="onSeek"
      />
      <span class="flex h-5 w-6 items-center justify-center rounded border border-emerald-400/40 bg-emerald-400/10 font-mono text-[9px] font-bold text-emerald-300">VU</span>
      <button class="rounded p-1 text-slate-400 transition hover:text-emerald-300" title="Fullscreen" @click="requestFullscreen">
        <ArrowsPointingOutIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- BROWSE MEDIA details -->
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
        <dd class="text-slate-200">{{ clip ? 'Recorded segment' : '—' }}</dd>

        <dt class="self-start text-slate-500">Duration</dt>
        <dd class="text-right font-mono text-slate-200">
          <div>{{ timecode(duration) }}</div>
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
