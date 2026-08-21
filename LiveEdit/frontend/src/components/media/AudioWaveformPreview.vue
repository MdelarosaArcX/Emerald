<script setup lang="ts">
/**
 * Playable audio waveform preview, drawn with wavesurfer.js.
 *
 * This is the auditioning counterpart to the timeline's ClipWaveform: where that one is a pure
 * renderer for a clip already placed on a track, this one owns a media element so an operator can
 * click a source and actually hear it before committing to using it.
 *
 * The shape is still drawn from the backend's precomputed peaks (see waveformCache), not from a
 * browser decode. Handing WaveSurfer `peaks` + `duration` alongside the URL makes it skip fetching
 * and decoding the file purely to draw it — a recorded segment is ~126MB and decodes to several
 * times that in memory, which is not a cost a browser grid of previews can absorb. The URL is then
 * only ever loaded by the <audio> element, and only once playback is actually asked for.
 */
import { getSourcePeaks, type SourcePeaks } from '@/services/waveformCache';
import { PauseIcon, PlayIcon } from '@heroicons/vue/24/solid';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import WaveSurfer from 'wavesurfer.js';

const props = withDefaults(
  defineProps<{
    /** Media URL to preview — anything with an audio track (audio file or A/V segment). */
    url: string;
    /** Waveform colour; the played region is drawn brighter than the rest. */
    color?: string;
    /** Whether clicking the waveform seeks and plays. Off makes this a static thumbnail. */
    playable?: boolean;
  }>(),
  { color: '#34d399', playable: true },
);

const emit = defineEmits<{
  /** Fired when this preview starts playing, so a parent grid can stop whichever was playing. */
  play: [];
}>();

const container = ref<HTMLDivElement | null>(null);
// shallowRef, not ref: a WaveSurfer instance is a large graph of canvases, media elements and
// observers, and making it deeply reactive would have Vue walk the whole thing on every access.
const wavesurfer = shallowRef<WaveSurfer | null>(null);
const source = shallowRef<SourcePeaks | null>(null);
const failed = ref(false);
const playing = ref(false);
const currentTime = ref(0);

/** Media element the preview plays through. Created lazily — see `startPlayback`. */
const media = shallowRef<HTMLAudioElement | null>(null);

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const duration = computed(() => source.value?.duration ?? 0);
const elapsedLabel = computed(() => `${formatTime(currentTime.value)} / ${formatTime(duration.value)}`);

function destroy(): void {
  // WaveSurfer throws from destroy() if a load it started is still in flight; nothing useful can be
  // done about that at teardown and it must not stop the instance being dropped.
  try { wavesurfer.value?.destroy(); } catch { /* already gone */ }
  wavesurfer.value = null;
  media.value = null;
  playing.value = false;
  currentTime.value = 0;
}

function render(): void {
  if (!container.value || !source.value) return;

  destroy();

  // The media element is built here rather than left to WaveSurfer so its `src` can stay unset
  // until playback is requested. WaveSurfer only assigns the src when it loads a URL, and passing
  // one up front would have every preview in a grid open a connection to a large file on mount.
  const audio = new Audio();
  audio.preload = 'none';
  audio.crossOrigin = 'anonymous';
  media.value = audio;

  wavesurfer.value = WaveSurfer.create({
    container: container.value,
    media: audio,
    peaks: [source.value.peaks],
    // Required alongside peaks — without a duration WaveSurfer has no timebase and draws nothing.
    duration: source.value.duration,
    height: 'auto',
    waveColor: `${props.color}66`,
    progressColor: props.color,
    cursorColor: props.color,
    cursorWidth: props.playable ? 1 : 0,
    barWidth: 2,
    barGap: 1,
    barRadius: 1,
    interact: props.playable,
    hideScrollbar: true,
    autoScroll: false,
    // Peaks arrive already normalised per source from waveformCache; normalising again here would
    // rescale each preview independently and make a quiet take look as loud as a hot one, which is
    // exactly the comparison this preview exists to support.
    normalize: false,
  });

  const ws = wavesurfer.value;
  ws.on('play', () => { playing.value = true; emit('play'); });
  ws.on('pause', () => { playing.value = false; });
  ws.on('finish', () => { playing.value = false; });
  ws.on('timeupdate', (time: number) => { currentTime.value = time; });
  // A seek by clicking the waveform should audition from there, which is the whole point of the
  // control. The clicked time is passed along explicitly because WaveSurfer's own seek writes to a
  // media element that has no src yet on the first click, and is silently lost.
  ws.on('interaction', (time: number) => { void startPlayback(time); });
}

/**
 * Attach the real media on first use, then play. Deferring the `src` to this moment is what keeps a
 * grid of previews from each pulling a large source down on mount; the waveform is already on
 * screen by then, drawn from the peaks.
 */
async function startPlayback(seekTo?: number): Promise<void> {
  const ws = wavesurfer.value;
  const audio = media.value;
  if (!ws || !audio) return;

  if (!audio.src) {
    audio.src = props.url;
    // The element has to know its duration before a seek means anything; until then currentTime
    // writes are dropped and the audition would start from the top regardless of where it was
    // clicked. preload is 'none', so nothing has been requested before this point.
    if (seekTo !== undefined && !audio.readyState) {
      await new Promise<void>((resolve) => {
        audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
        audio.addEventListener('error', () => resolve(), { once: true });
        audio.load();
      });
      // The instance may have been torn down or reloaded while that was in flight.
      if (wavesurfer.value !== ws) return;
    }
  }

  if (seekTo !== undefined) ws.setTime(seekTo);

  try {
    await ws.play();
  } catch {
    // Autoplay policy, a source that turned out unplayable, or a teardown mid-load. The preview
    // stays as a static waveform rather than reporting a failure the operator can't act on.
    playing.value = false;
  }
}

function toggle(): void {
  if (!props.playable) return;
  if (playing.value) wavesurfer.value?.pause();
  else void startPlayback();
}

/** Stop this preview — used by a parent grid to keep only one audition audible at a time. */
function stop(): void {
  wavesurfer.value?.pause();
}

async function loadSource(): Promise<void> {
  failed.value = false;
  try {
    source.value = await getSourcePeaks(props.url);
  } catch {
    // No audio track, or the extraction failed / is cooling down. The flat line below stands in.
    failed.value = true;
    source.value = null;
    destroy();
    return;
  }
  render();
}

onMounted(loadSource);

watch(() => props.url, loadSource);
watch(() => [props.color, props.playable], () => { if (source.value) render(); });

onBeforeUnmount(destroy);

defineExpose({ stop, playing });
</script>

<template>
  <div class="group/wave relative h-full w-full">
    <div ref="container" class="h-full w-full" />

    <!-- Until the peaks arrive (or if the source has no audio at all) a centre line stands in.
         Deliberately not a plausible-looking placeholder waveform: a shape that doesn't correspond
         to the audio is worse than an obviously empty one, because it invites judgements against
         material that isn't there. -->
    <div
      v-if="!source"
      class="pointer-events-none absolute inset-0 flex items-center"
      :title="failed ? 'No readable audio in this source' : 'Reading audio…'"
    >
      <span class="h-px w-full" :style="{ backgroundColor: color, opacity: failed ? 0.3 : 0.55 }" />
    </div>

    <!-- Transport overlay. The button is a real target for keyboard/click; clicking the waveform
         itself seeks and plays via WaveSurfer's own interaction handling. -->
    <button
      v-if="playable && source"
      type="button"
      class="absolute left-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/70 text-white opacity-0 transition group-hover/wave:opacity-100 focus:opacity-100 focus:outline-none"
      :class="{ 'opacity-100': playing }"
      :title="playing ? 'Pause preview' : 'Play preview'"
      @click.stop="toggle"
    >
      <PauseIcon v-if="playing" class="h-3 w-3" />
      <PlayIcon v-else class="h-3 w-3 translate-x-[1px]" />
    </button>

    <span
      v-if="playable && source"
      class="pointer-events-none absolute bottom-0 left-8 font-mono text-[0.5625rem] text-white/70 opacity-0 transition group-hover/wave:opacity-100"
      :class="{ 'opacity-100': playing }"
    >
      {{ elapsedLabel }}
    </span>
  </div>
</template>
