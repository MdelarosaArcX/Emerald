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
import { useTimecode } from '@/composables/useTimecode';
import { useOnAirStore } from '@/stores/onAirStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue';

const timelineStore = useTimelineStore();
const onAirStore = useOnAirStore();

const frameRef = ref<HTMLElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const volume = ref(100);
const speed = ref(1);
const speedOptions = [0.25, 0.5, 1, 1.5, 2];
// Lives on the timeline store (not a local ref) so TimelineEditor can gate its playhead-follow
// auto-scroll on the same "is playback actually advancing the playhead" signal.
const isPlaying = computed(() => timelineStore.isPlaying);

const proxyUrl = ref('');
const proxyLoading = ref(false);

const fps = computed(() => timelineStore.fps || 25);

// Shared helper rather than a local copy of the same arithmetic: this readout is the same
// local-time-of-day HH:MM:SS:FF the ruler and status bar show, and the duplicate here was missing
// their 24h wrap, so a session running through midnight read 24:xx:xx here and 00:xx:xx there.
const { framesToTimecode } = useTimecode(() => fps.value);
const timecode = computed(() => framesToTimecode(timelineStore.playhead));

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

// --- Proxy: request a playable version whenever the active clip's source changes ---
// Recorded segments straight from the Emerald backend (both the regular recording pipeline's
// stream-copied .mp4 and the edit-capture pipeline's own proxy) are already real, browser-playable
// H.264 MP4 — re-encoding them through ensureProxy() would just transcode a second time for no
// benefit. Only genuinely non-browser-playable sources (e.g. a ProRes MOV master, if one's ever
// wired up here) still need it.
function isAlreadyPlayableMp4(src: string): boolean {
  return /\.mp4(\?|#|$)/i.test(src);
}

let proxyToken = 0;
watch(
  activeSource,
  async (src) => {
    proxyUrl.value = '';
    stopRaf();
    if (!/^https?:/i.test(src)) {
      proxyLoading.value = false;
      return;
    }
    if (isAlreadyPlayableMp4(src)) {
      proxyLoading.value = false;
      proxyUrl.value = src;
      return;
    }
    const token = ++proxyToken;
    proxyLoading.value = true;
    const url = await requestProxy(src);
    if (token !== proxyToken) return; // superseded by a newer active clip
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
    v.muted = activeMuted.value;
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
function seekToPlayhead(): void {
  const v = videoRef.value;
  if (!v || !proxyUrl.value) return;
  const t = sourceSecondsAt(timelineStore.playhead);
  if (Number.isFinite(t) && Math.abs(v.currentTime - t) > 0.15) v.currentTime = t;
}
function onLoadedData(): void {
  const v = videoRef.value;
  if (!v) return;
  v.playbackRate = speed.value;
  // Apply the current volume and only mute when explicitly muted — so recorded segments' audio
  // actually plays out of the Program monitor by default.
  v.volume = Math.max(0, Math.min(1, volume.value / 100));
  v.muted = activeMuted.value;
  seekToPlayhead();
  if (isPlaying.value) v.play().catch(() => {});
}

// video → timeline while playing (guarded so the playhead watcher below won't seek back)
function onTimeUpdate(): void {
  const v = videoRef.value;
  const a = active.value;
  if (!v || !a || !isPlaying.value || !proxyUrl.value) return;
  const c = a.clip;
  const frame = Math.round(c.start + v.currentTime * fps.value - (c.trimIn ?? 0));
  if (frame >= c.start + c.duration - 1) {
    advanceToNextClip();
    return;
  }
  timelineStore.setPlayhead(Math.max(c.start, frame), false);
}
function onVideoEnded(): void {
  advanceToNextClip();
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
}

// timeline → video on external scrub
watch(
  () => timelineStore.playhead,
  (frame) => {
    const v = videoRef.value;
    const a = active.value;
    if (!v || !a || !proxyUrl.value) return;
    const videoFrame = Math.round(a.clip.start + v.currentTime * fps.value - (a.clip.trimIn ?? 0));
    if (Math.abs(videoFrame - frame) <= 1) return; // originated from the video
    v.currentTime = sourceSecondsAt(frame);
  },
);

// --- Fallback playback loop (thumbnail-only clips / while a proxy generates) ---
let rafId = 0;
let lastTs = 0;
let pos = 0;
function rafLoop(ts: number): void {
  if (!isPlaying.value || proxyUrl.value) {
    stopRaf();
    return;
  }
  if (!lastTs) lastTs = ts;
  pos += ((ts - lastTs) / 1000) * fps.value * speed.value;
  lastTs = ts;
  if (pos >= timelineStore.duration) {
    timelineStore.setPlayhead(timelineStore.duration, false);
    pause();
    return;
  }
  timelineStore.setPlayhead(Math.round(pos), false);
  rafId = requestAnimationFrame(rafLoop);
}
function startRaf(): void {
  pos = timelineStore.playhead >= timelineStore.duration ? 0 : timelineStore.playhead;
  lastTs = 0;
  rafId = requestAnimationFrame(rafLoop);
}
function stopRaf(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function play(): void {
  if (timelineStore.duration <= 0) return;
  // Following air owns the playhead — the two would fight over it frame by frame. Hitting play is
  // an explicit request to drive the timeline by hand, so it wins and follow disengages.
  if (onAirStore.following) onAirStore.setFollowing(false);
  // Frame 0 is midnight (see timelineStore.appendCaptureSegment) — a playhead left at 0, or
  // anywhere before the first clip, sits in a real-time gap that could be hours long. Jump to the
  // first clip instead of starting playback somewhere with nothing to show. Only when the
  // playhead is actually before all content — scrubbing into the middle of the timeline and
  // hitting play still resumes from exactly there, same as before.
  const earliestFrame = timelineStore.earliestClipFrame;
  if (earliestFrame != null && timelineStore.playhead < earliestFrame) {
    timelineStore.setPlayhead(earliestFrame, false);
  }
  timelineStore.setPlaying(true);
  if (proxyUrl.value && videoRef.value) videoRef.value.play().catch(() => {});
  else startRaf();
}
function pause(): void {
  timelineStore.setPlaying(false);
  stopRaf();
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

// --- Transport keyboard shortcuts --------------------------------------------------------------
// Space toggles play/pause, Right/Left step a single frame on the timeline.
//
// Bound on window rather than on the timeline element so they work wherever focus happens to be —
// transport keys shouldn't depend on having clicked the right panel first. They live in this
// component because it owns play/pause/stepFrame and the <video> they drive; TimelineEditor keeps
// its own editing keys (X to cut, Delete to remove) on a separate listener, and the two sets don't
// overlap.
//
// Each of these keys already means something to the browser: Space scrolls the page and re-triggers
// the last-clicked button (so clicking Play with the mouse and then pressing Space would otherwise
// toggle twice), and the arrows scroll too — hence preventDefault on every key actually handled.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  );
}

function onTransportKeydown(event: KeyboardEvent): void {
  // Leave the browser's own chords (Ctrl/Cmd/Alt + key) alone.
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;

  if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    if (isPlaying.value) pause();
    else play();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepFrame(1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepFrame(-1);
  }
}

onMounted(() => window.addEventListener('keydown', onTransportKeydown));
onUnmounted(() => window.removeEventListener('keydown', onTransportKeydown));

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
        <!-- Thumbnail frame (shown when no proxy is playing yet) -->
        <div
          v-if="active && active.clip.thumbnail"
          v-show="!proxyUrl"
          class="absolute inset-0 bg-contain bg-center bg-no-repeat"
          :style="{ ...previewStyle, backgroundImage: `url(${active.clip.thumbnail})` }"
        />
        <!-- Real proxy video -->
        <video
          v-show="active && proxyUrl"
          ref="videoRef"
          class="absolute inset-0 h-full w-full object-contain"
          :style="previewStyle"
          playsinline
          @loadeddata="onLoadedData"
          @timeupdate="onTimeUpdate"
          @ended="onVideoEnded"
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
        <div v-if="proxyLoading" class="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-[10px] text-slate-200 backdrop-blur">
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
