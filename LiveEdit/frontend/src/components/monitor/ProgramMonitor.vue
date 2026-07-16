<script setup lang="ts">
/**
 * Center panel: the Program Monitor. Plays the recorded clip loaded from the
 * Media Browser (programStore) in a Video.js surface flanked by VU meters, with
 * a large centered timecode. The transport bar and the timeline playhead are
 * two-way bound to the video so you can scrub/step frame-for-frame.
 */
import AudioMeter from '@/components/monitor/AudioMeter.vue';
import TransportControls from '@/components/monitor/TransportControls.vue';
import { useTimecode } from '@/composables/useTimecode';
import { useProgramStore } from '@/stores/programStore';
import { useTimelineStore } from '@/stores/timelineStore';
import 'video.js/dist/video-js.css';
import videojs from 'video.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const programStore = useProgramStore();
const timelineStore = useTimelineStore();
const { framesToTimecode } = useTimecode(programStore.fps);

const videoRef = ref<HTMLVideoElement | null>(null);
let player: ReturnType<typeof videojs> | null = null;
let rvfcHandle = 0;

const volume = ref(100);
const speed = ref(1);
const speedOptions = [0.25, 0.5, 1, 1.5, 2];

const fps = programStore.fps;
const timecode = computed(() => framesToTimecode(programStore.currentFrame));
const meterLevel = computed(() => (programStore.isPlaying ? volume.value : 0));

onMounted(() => {
  if (!videoRef.value) return;
  player = videojs(videoRef.value, { controls: false, autoplay: false, fluid: false, responsive: true, bigPlayButton: false });

  player.on('play', () => programStore.setPlaying(true));
  player.on('pause', () => programStore.setPlaying(false));
  player.on('ended', () => programStore.setPlaying(false));
  player.on('loadedmetadata', onLoadedMetadata);
  player.on('seeked', pushFrameToTimeline);
  player.on('timeupdate', pushFrameToTimeline);

  if (programStore.clip) player.src({ src: programStore.clip.url, type: 'video/mp4' });
});

onBeforeUnmount(() => {
  if (rvfcHandle && videoRef.value) (videoRef.value as unknown as { cancelVideoFrameCallback?: (h: number) => void }).cancelVideoFrameCallback?.(rvfcHandle);
  player?.dispose();
});

// Load a newly selected clip into the player.
watch(() => programStore.clip?.url, (url) => {
  if (!player) return;
  if (url) player.src({ src: url, type: 'video/mp4' });
});

function onLoadedMetadata(): void {
  if (!player) return;
  const v = videoRef.value;
  const durationSeconds = Number(player.duration()) || 0;
  programStore.setMeta({ durationSeconds, width: v?.videoWidth ?? 0, height: v?.videoHeight ?? 0 });
  timelineStore.loadProgramClip({
    name: programStore.clip?.fileName ?? 'Clip',
    thumbnail: programStore.clip?.thumbnailUrl ?? '',
    durationFrames: Math.round(durationSeconds * fps),
    fps,
  });
  startFrameLoop();
}

// Push the video's current position to the shared timeline playhead. The playhead watcher below
// won't seek back because the computed video frame already matches (guarded by frame comparison).
function pushFrameToTimeline(): void {
  if (!player) return;
  const t = Number(player.currentTime()) || 0;
  programStore.setCurrentTime(t);
  timelineStore.setPlayhead(Math.round(t * fps), false);
}

// Per-frame updates while playing, for smooth timecode/playhead tracking.
function startFrameLoop(): void {
  const v = videoRef.value as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }) | null;
  if (!v?.requestVideoFrameCallback) return;
  const tick = () => {
    pushFrameToTimeline();
    rvfcHandle = v.requestVideoFrameCallback!(tick);
  };
  rvfcHandle = v.requestVideoFrameCallback(tick);
}

// Timeline → video: when the playhead is moved from elsewhere (scrub, ruler click), seek the
// video there. Skips when the playhead already matches the video (i.e. it came from the video).
watch(() => timelineStore.playhead, (frame) => {
  if (!player || !programStore.clip) return;
  const videoFrame = Math.round((Number(player.currentTime()) || 0) * fps);
  if (Math.abs(videoFrame - frame) <= 1) return;
  player.currentTime(frame / fps);
});

function play(): void { player?.play(); }
function pause(): void { player?.pause(); }
function stop(): void { player?.pause(); player?.currentTime(0); }
function stepFrame(delta: number): void {
  if (!player) return;
  player.pause();
  player.currentTime(Math.max(0, (Number(player.currentTime()) || 0) + delta / fps));
}
function jumpSeconds(seconds: number): void {
  if (!player) return;
  player.currentTime(Math.max(0, (Number(player.currentTime()) || 0) + seconds));
}
function handleFullscreen(): void { player?.requestFullscreen(); }
function setVolume(value: number): void { volume.value = value; player?.volume(value / 100); }
function setSpeed(value: number): void { speed.value = value; player?.playbackRate(value); }
</script>

<template>
  <section class="flex h-full flex-col gap-2.5 rounded-xl border border-white/5 bg-surface-900/80 p-3 shadow-panel">
    <!-- Centered program timecode -->
    <header class="relative flex items-center justify-center">
      <h2 class="absolute left-0 truncate pr-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
        {{ programStore.clip ? programStore.clip.fileName : 'Program' }}
      </h2>
      <div class="font-mono text-3xl font-semibold tracking-widest text-slate-100" style="text-shadow: 0 0 18px rgba(23,228,219,0.35)">
        {{ timecode }}
      </div>
      <span class="absolute right-0 text-[10px] uppercase tracking-widest text-slate-500">{{ fps.toFixed(2) }} fps</span>
    </header>

    <div class="relative flex min-h-0 flex-1 items-stretch gap-2 overflow-hidden rounded-lg border border-white/5 bg-black">
      <!-- Left VU meter -->
      <div class="flex w-9 shrink-0 flex-col items-center border-r border-white/5 bg-surface-900/60 py-3">
        <AudioMeter class="flex-1" :level="meterLevel" />
        <div class="mt-1 flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>3</span><span>3</span><span>3</span><span>3</span></div>
        <div class="flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>dB</span><span>dB</span></div>
      </div>

      <div class="relative flex min-w-0 flex-1 items-center justify-center">
        <video ref="videoRef" class="video-js h-full w-full" playsinline />
        <div v-if="!programStore.clip" class="pointer-events-none absolute inset-0 flex items-center justify-center bg-grid-fade text-center text-xs text-slate-600">
          Select a clip in the Media Browser to load it here.
        </div>
      </div>

      <!-- Right VU meter -->
      <div class="flex w-9 shrink-0 flex-col items-center border-l border-white/5 bg-surface-900/60 py-3">
        <AudioMeter class="flex-1" :level="meterLevel" />
        <div class="mt-1 flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>3</span><span>3</span><span>3</span><span>3</span></div>
        <div class="flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>dB</span><span>dB</span></div>
      </div>
    </div>

    <TransportControls
      :is-playing="programStore.isPlaying"
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

<style scoped>
:deep(.video-js) {
  background-color: transparent;
}
</style>
