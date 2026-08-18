<script setup lang="ts">
/**
 * Real audio waveform for one timeline clip, drawn with wavesurfer.js.
 *
 * WaveSurfer is used purely as a renderer here — it is handed a precomputed peak array and never
 * given a URL or a media element. That matters for a timeline: the default behaviour of fetching
 * and decoding per instance would download the whole segment (~126MB for two minutes of 1080p)
 * once per clip, and each instance would build an <audio> element nobody plays, since the
 * timeline's own transport drives playback. The peaks come from the backend's /api/waveform
 * instead, once per source — see waveformCache.
 *
 * Peaks are sliced to the clip's trim range, so trimming a clip's handles or splitting it at the
 * playhead reveals the correct part of the waveform rather than rescaling the whole source into
 * whatever width is left.
 */
import { getSourcePeaks, slicePeaks, type SourcePeaks } from '@/services/waveformCache';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import WaveSurfer from 'wavesurfer.js';

const props = defineProps<{
  /** Media URL to read audio from — the clip's source file. */
  url: string;
  /** Clip trim window, in seconds from the start of the source. */
  trimInSeconds: number;
  trimOutSeconds: number;
  /** Rendered width in pixels; drives how many peak buckets are worth drawing. */
  width: number;
  color: string;
}>();

const container = ref<HTMLDivElement | null>(null);
// shallowRef, not ref: WaveSurfer instances are large graphs of canvases and observers, and
// making one deeply reactive would have Vue walk the whole thing on every access.
const wavesurfer = shallowRef<WaveSurfer | null>(null);
const source = shallowRef<SourcePeaks | null>(null);
const failed = ref(false);

/**
 * One bar per ~3px of clip width. Asking for a bucket per pixel produces bars thinner than the
 * 1px minimum WaveSurfer will draw, which just renders as a solid block — the same unreadable
 * result this component replaced.
 */
const bucketCount = computed(() => Math.max(16, Math.floor(Math.max(props.width, 1) / 3)));

const peaks = computed<number[] | null>(() => {
  if (!source.value) return null;
  return slicePeaks(source.value, props.trimInSeconds, props.trimOutSeconds, bucketCount.value);
});

function destroy(): void {
  // WaveSurfer throws from destroy() if a decode it started is still in flight; nothing useful can
  // be done about it at teardown and it must not prevent the instance being dropped.
  try { wavesurfer.value?.destroy(); } catch { /* already gone */ }
  wavesurfer.value = null;
}

function render(): void {
  if (!container.value || !peaks.value) return;

  destroy();

  wavesurfer.value = WaveSurfer.create({
    container: container.value,
    peaks: [peaks.value],
    // Required alongside peaks — without it WaveSurfer has no timebase and renders nothing.
    duration: Math.max(0.001, props.trimOutSeconds - props.trimInSeconds),
    height: 'auto',
    waveColor: props.color,
    // Same as waveColor: there is no playback head inside a clip, so a differently coloured
    // "played" region would be meaningless.
    progressColor: props.color,
    cursorWidth: 0,
    barWidth: 2,
    barGap: 1,
    barRadius: 1,
    // The clip block itself owns pointer handling for drag/trim/select. Left interactive,
    // WaveSurfer would swallow those events and clicking a clip would seek instead of select it.
    interact: false,
    hideScrollbar: true,
    autoScroll: false,
    // Peaks are already normalised per source in waveformCache; normalising again per visible
    // slice would rescale each trim independently and make a quiet passage look as loud as a
    // peak, which is misleading when comparing takes.
    normalize: false,
  });
}

onMounted(async () => {
  try {
    source.value = await getSourcePeaks(props.url);
  } catch {
    // A source with no audio track, or one that failed to fetch. The parent draws a flat line.
    failed.value = true;
    return;
  }
  render();
});

// Re-render on trim, zoom or source change. Width is included because the bucket count is derived
// from it, so zooming in genuinely reveals more detail rather than stretching the same bars.
watch(
  () => [props.url, props.trimInSeconds, props.trimOutSeconds, bucketCount.value, props.color],
  async ([url], [previousUrl]) => {
    if (url !== previousUrl) {
      failed.value = false;
      try {
        source.value = await getSourcePeaks(props.url);
      } catch {
        failed.value = true;
        destroy();
        return;
      }
    }
    render();
  },
);

onBeforeUnmount(destroy);

defineExpose({ failed });
</script>

<template>
  <div class="relative h-full w-full">
    <div ref="container" class="h-full w-full" />
    <!-- Until the source has been decoded (or if it has no audio at all) a centre line stands in.
         Deliberately not the old fake bars: a plausible-looking waveform that doesn't correspond
         to the audio is worse than an obviously empty one, because it invites edits against it. -->
    <div
      v-if="!peaks"
      class="pointer-events-none absolute inset-0 flex items-center"
      :title="failed ? 'No readable audio in this source' : 'Reading audio…'"
    >
      <span class="h-px w-full" :style="{ backgroundColor: color, opacity: failed ? 0.3 : 0.55 }" />
    </div>
  </div>
</template>
