<script setup lang="ts">
/**
 * Center Program monitor — previews the TIMELINE (the edit). At the playhead it renders the active
 * video clip. If a browser-playable proxy of that clip is available it plays the real video (with
 * the clip's effects/opacity/transform + mute); otherwise it shows the clip's thumbnail. Cuts,
 * trims, effect toggles and opacity all reflect live; Play runs through the sequence, advancing
 * across clip boundaries.
 */
import AudioMeter from '@/components/monitor/AudioMeter.vue';
import TransportControls from '@/components/monitor/TransportControls.vue';
import { requestProxy } from '@/services/render';
import { useTimelineStore } from '@/stores/timelineStore';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const timelineStore = useTimelineStore();

const frameRef = ref<HTMLElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const volume = ref(100);
const speed = ref(1);
const speedOptions = [0.25, 0.5, 1, 1.5, 2];
const isPlaying = ref(false);

const proxyUrl = ref('');
const proxyLoading = ref(false);

const fps = computed(() => timelineStore.fps || 25);

const timecode = computed(() => {
  const f = Math.max(1, Math.round(fps.value));
  const total = Math.max(0, Math.round(timelineStore.playhead));
  const ff = total % f;
  const secs = Math.floor(total / f);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(ff)}`;
});

/** Active video clip under the playhead (topmost visible non-audio track). */
const active = computed(() => {
  const frame = timelineStore.playhead;
  for (const t of timelineStore.tracks) {
    if (t.kind === 'audio' || !t.visible) continue;
    const clip = t.clips.find((c) => frame >= c.start && frame < c.start + c.duration);
    if (clip) return { clip, track: t };
  }
  return null;
});
const activeSource = computed(() => active.value?.clip.path || '');
const hasClip = computed(() => timelineStore.tracks.some((t) => t.clips.length > 0));
const activeEffects = computed(() => active.value?.clip.effects.filter((e) => e.enabled).map((e) => e.name) ?? []);

const previewStyle = computed(() => {
  const a = active.value;
  if (!a) return {} as Record<string, string>;
  const c = a.clip;
  const filters: string[] = [];
  for (const e of c.effects) {
    if (!e.enabled) continue;
    const n = e.name.toLowerCase();
    if (n.includes('blur')) filters.push('blur(5px)');
    if (n.includes('noise')) filters.push('saturate(1.15)');
  }
  return {
    opacity: String(Math.max(0, Math.min(1, (c.opacity ?? 100) / 100))),
    filter: filters.length ? filters.join(' ') : 'none',
    transform: `scale(${(c.scale ?? 100) / 100}) rotate(${c.rotation ?? 0}deg)`,
  };
});
const activeMuted = computed(() => {
  const a = active.value;
  if (!a) return false;
  const audioMuted = timelineStore.tracks.some((t) => t.kind === 'audio' && t.muted);
  return audioMuted || a.clip.effects.some((e) => e.enabled && e.name.toLowerCase().includes('mute'));
});
const meterLevel = computed(() => (isPlaying.value && !activeMuted.value ? volume.value : 0));

// --- Playback source -------------------------------------------------------------------------
// The <video> plays a lightweight, browser-friendly PROXY (480p faststart) of the active clip —
// the raw Emerald segments are large, non-faststart 4K files that stall the browser. While a proxy
// is still transcoding, the clip thumbnail is shown and a synthetic clock keeps the playhead
// sweeping; playback hands off to the real video the moment its proxy is ready.
let proxyToken = 0;
const proxyCache = new Map<string, string>(); // source URL → proxy URL (avoid re-requesting)

async function ensureProxy(src: string): Promise<string> {
  if (!/^https?:/i.test(src)) return '';
  const cached = proxyCache.get(src);
  if (cached) return cached;
  const url = (await requestProxy(src)) ?? '';
  if (url) proxyCache.set(src, url);
  return url;
}

const PREFETCH_AHEAD = 3;
/** Source paths of the next few clips after the active one, in order (for prefetching proxies). */
function upcomingSources(): string[] {
  const a = active.value;
  if (!a) return [];
  return a.track.clips
    .filter((c) => c.start > a.clip.start && /^https?:/i.test(c.path))
    .sort((x, y) => x.start - y.start)
    .slice(0, PREFETCH_AHEAD)
    .map((c) => c.path);
}
/** Warm the next few clips' proxies so boundary crossings play without a transcode gap. */
function prefetchAhead(): void {
  for (const src of upcomingSources()) void ensureProxy(src);
}

watch(
  activeSource,
  async (src) => {
    proxyUrl.value = '';
    if (!/^https?:/i.test(src)) {
      proxyLoading.value = false;
      return;
    }
    const token = ++proxyToken;
    proxyLoading.value = true;
    prefetchAhead(); // start warming upcoming clips immediately, in parallel with this one
    const url = await ensureProxy(src);
    if (token !== proxyToken) return; // superseded by a newer active clip
    proxyLoading.value = false;
    proxyUrl.value = url;
    prefetchAhead();
  },
  { immediate: true },
);

// A proxy is available once we have its URL. Note this is a *relative* path (e.g. "/proxies/x.mp4")
// served by our own dev server / backend — do NOT test it against /^https?:/ (that check was the bug
// that kept the <video> hidden and left only the thumbnail showing).
const hasVideo = computed(() => proxyUrl.value.length > 0);

watch(proxyUrl, (url) => {
  const v = videoRef.value;
  if (!v) return;
  if (url) {
    v.src = url;
    v.muted = activeMuted.value;
    v.playbackRate = speed.value;
    v.load();
  } else {
    v.removeAttribute('src');
    v.load();
  }
});
watch(activeMuted, (m) => {
  if (videoRef.value) videoRef.value.muted = m;
});

function sourceSecondsAt(frame: number): number {
  const a = active.value;
  if (!a) return 0;
  return Math.max(0, (frame - a.clip.start + (a.clip.trimIn ?? 0)) / fps.value);
}

/**
 * Start the video, surviving the browser's autoplay policy: if a play with audio is rejected
 * (proxy finished after the click, so no fresh user gesture), retry muted, then restore audio.
 */
function playVideo(v: HTMLVideoElement): void {
  const p = v.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      v.muted = true;
      v.play()
        .then(() => {
          v.muted = activeMuted.value;
        })
        .catch(() => {});
    });
  }
}

function onLoadedData(): void {
  const v = videoRef.value;
  if (!v) return;
  v.playbackRate = speed.value;
  // Fit the (placeholder-length) clip to the real source duration so the slot reflects the actual
  // segment length (capped at the next clip so lanes never overlap).
  const a = active.value;
  if (a && a.clip.autoFit && Number.isFinite(v.duration) && v.duration > 0) {
    timelineStore.fitClipToSource(a.clip.id, Math.round(v.duration * fps.value));
  }
  v.currentTime = sourceSecondsAt(timelineStore.playhead);
  if (isPlaying.value) playVideo(v); // hand off from the synthetic clock to real video
}

// --- Playhead: video-driven while a proxy plays, synthetic while one transcodes ---------------
// The real <video> is the clock when present (the rAF loop reads its currentTime each frame so the
// playhead tracks decoded video 1:1 — smooth, no seek-thrash), so the whole segment plays through.
// When there is no proxy yet the loop advances the playhead itself so it still sweeps over the
// thumbnail. onVideoEnded is a safety net for the clip→clip boundary.
function onVideoEnded(): void {
  if (isPlaying.value) advanceToNextClip();
}
// If a proxy fails to load/decode, don't freeze the sequence — skip past this clip while playing.
function onVideoError(): void {
  if (isPlaying.value) advanceToNextClip();
}
function advanceToNextClip(): void {
  const a = active.value;
  if (!a) {
    pause();
    return;
  }
  const next = a.clip.start + a.clip.duration;
  if (next >= timelineStore.duration) {
    timelineStore.setPlayhead(timelineStore.duration, false);
    pause();
    return;
  }
  timelineStore.setPlayhead(next, false); // active changes → next proxy loads and auto-plays
  pos = next;
}

// External scrub (ruler click / step / jump): move the video to the playhead when paused.
watch(
  () => timelineStore.playhead,
  (frame) => {
    const v = videoRef.value;
    if (!v || !hasVideo.value || isPlaying.value) return;
    const want = sourceSecondsAt(frame);
    if (Number.isFinite(want) && Math.abs(v.currentTime - want) > 0.2) v.currentTime = want;
  },
);

let rafId = 0;
let lastTs = 0;
let pos = 0;
function loop(ts: number): void {
  if (!isPlaying.value) {
    rafId = 0;
    return;
  }
  if (!lastTs) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  const v = videoRef.value;
  const a = active.value;
  if (hasVideo.value && v && a) {
    // A proxy is loaded: the video is the clock. Keep it playing (recover from autoplay blocks or
    // brief stalls) and read its decoded position each frame. Never advance the playhead past the
    // video, so "video playing" and "playhead moving" stay one and the same.
    if (v.paused && v.readyState >= 2) playVideo(v);
    if (v.readyState >= 1) {
      const c = a.clip;
      const frame = Math.round(c.start + v.currentTime * fps.value - (c.trimIn ?? 0));
      if (frame >= c.start + c.duration - 1) {
        advanceToNextClip();
      } else {
        timelineStore.setPlayhead(Math.max(c.start, frame), false);
        pos = timelineStore.playhead;
      }
    }
    // readyState < 1 → still loading this clip; wait (the poster/thumbnail shows meanwhile).
  } else {
    // No proxy yet — advance the playhead ourselves so it keeps sweeping over the thumbnail.
    pos += dt * fps.value * speed.value;
    if (pos >= timelineStore.duration) {
      timelineStore.setPlayhead(timelineStore.duration, false);
      pause();
      return;
    }
    timelineStore.setPlayhead(Math.round(pos), false);
  }
  rafId = requestAnimationFrame(loop);
}

function play(): void {
  if (timelineStore.duration <= 0) return;
  if (timelineStore.playhead >= timelineStore.duration) timelineStore.setPlayhead(0, false);
  isPlaying.value = true;
  pos = timelineStore.playhead;
  lastTs = 0;
  const v = videoRef.value;
  if (v && hasVideo.value) {
    v.currentTime = sourceSecondsAt(timelineStore.playhead);
    playVideo(v); // user gesture → authorized
  }
  if (!rafId) rafId = requestAnimationFrame(loop);
}
function pause(): void {
  isPlaying.value = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  videoRef.value?.pause();
}
function stop(): void {
  pause();
  timelineStore.setPlayhead(0, false);
}
function stepFrame(delta: number): void {
  pause();
  timelineStore.setPlayhead(timelineStore.playhead + delta, false);
}
function jumpSeconds(seconds: number): void {
  pause();
  timelineStore.setPlayhead(timelineStore.playhead + Math.round(seconds * fps.value), false);
}
function handleFullscreen(): void {
  frameRef.value?.requestFullscreen?.();
}
function setVolume(value: number): void {
  volume.value = value;
  if (videoRef.value) videoRef.value.volume = Math.max(0, Math.min(1, value / 100));
}
function setSpeed(value: number): void {
  speed.value = value;
  if (videoRef.value) videoRef.value.playbackRate = value;
}

onBeforeUnmount(pause);
</script>

<template>
  <section class="flex h-full flex-col gap-2.5 rounded-xl border border-white/5 bg-surface-900/80 p-3 shadow-panel">
    <header class="relative flex items-center justify-center">
      <h2 class="absolute left-0 max-w-[40%] truncate pr-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
        {{ active ? active.clip.name : 'Program' }}
      </h2>
      <div class="font-mono text-3xl font-semibold tracking-widest text-slate-100" style="text-shadow: 0 0 18px rgba(23,228,219,0.35)">
        {{ timecode }}
      </div>
      <span class="absolute right-0 text-[10px] uppercase tracking-widest text-slate-500">{{ fps.toFixed(2) }} fps</span>
    </header>

    <div class="relative flex min-h-0 flex-1 items-stretch gap-2 overflow-hidden rounded-lg border border-white/5 bg-black">
      <div class="flex w-9 shrink-0 flex-col items-center border-r border-white/5 bg-surface-900/60 py-3">
        <AudioMeter class="flex-1" :level="meterLevel" />
        <div class="mt-1 flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>3</span><span>3</span><span>3</span><span>3</span></div>
        <div class="flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>dB</span><span>dB</span></div>
      </div>

      <div ref="frameRef" class="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black">
        <!-- Thumbnail frame (shown only when there is no playable video source) -->
        <div
          v-if="active && active.clip.thumbnail"
          v-show="!hasVideo"
          class="absolute inset-0 bg-contain bg-center bg-no-repeat"
          :style="{ ...previewStyle, backgroundImage: `url(${active.clip.thumbnail})` }"
        />
        <!-- Real video: original segment by default, upgraded to the proxy when ready -->
        <video
          v-show="active && hasVideo"
          ref="videoRef"
          class="absolute inset-0 h-full w-full object-contain"
          :style="previewStyle"
          :poster="active?.clip.thumbnail"
          playsinline
          @loadeddata="onLoadedData"
          @ended="onVideoEnded"
          @error="onVideoError"
        />

        <div v-if="!active" class="pointer-events-none absolute inset-0 flex items-center justify-center bg-grid-fade px-6 text-center text-xs text-slate-600">
          {{ hasClip ? 'No clip under the playhead — move it over a clip to preview' : 'Load or drag a clip onto the timeline to preview it here' }}
        </div>

        <!-- Overlays -->
        <div v-if="active && activeEffects.length" class="pointer-events-none absolute left-2 top-2 flex max-w-[70%] flex-wrap gap-1">
          <span v-for="fx in activeEffects" :key="fx" class="rounded bg-emerald-500/25 px-1.5 py-0.5 text-[9px] font-medium text-emerald-200 backdrop-blur">{{ fx }}</span>
        </div>
        <div v-if="active" class="pointer-events-none absolute right-2 top-2 flex items-center gap-1">
          <span v-if="(active.clip.opacity ?? 100) < 100" class="rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-slate-200 backdrop-blur">Opacity {{ active.clip.opacity }}%</span>
          <span v-if="activeMuted" class="rounded bg-rose-500/25 px-1.5 py-0.5 text-[9px] font-medium text-rose-300 backdrop-blur">MUTED</span>
        </div>
        <div v-if="proxyLoading && !hasVideo" class="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-[10px] text-slate-200 backdrop-blur">
          Preparing preview…
        </div>
      </div>

      <div class="flex w-9 shrink-0 flex-col items-center border-l border-white/5 bg-surface-900/60 py-3">
        <AudioMeter class="flex-1" :level="meterLevel" />
        <div class="mt-1 flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>3</span><span>3</span><span>3</span><span>3</span></div>
        <div class="flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>dB</span><span>dB</span></div>
      </div>
    </div>

    <TransportControls
      :is-playing="isPlaying"
      :volume="volume"
      :speed="speed"
      :speed-options="speedOptions"
      @play="play"
      @pause="pause"
      @stop="stop"
      @prev-frame="stepFrame(-1)"
      @next-frame="stepFrame(1)"
      @jump-back="jumpSeconds(-10)"
      @jump-forward="jumpSeconds(10)"
      @fullscreen="handleFullscreen"
      @update:volume="setVolume($event)"
      @update:speed="setSpeed($event)"
    />
  </section>
</template>
