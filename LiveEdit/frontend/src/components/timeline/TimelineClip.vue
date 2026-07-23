<script setup lang="ts">
/**
 * A single draggable/resizable/selectable clip block rendered on a
 * timeline track. Position and width are derived from frame values
 * multiplied by the current pixels-per-frame scale. The clip body is
 * rendered per media type — waveform (audio), filmstrip (video), or a
 * badge (title / image / fx) — matching the broadcast timeline design.
 */
import { useDragResize } from '@/composables/useDragResize';
import type { Clip } from '@/types/clip';
import { SparklesIcon } from '@heroicons/vue/24/solid';
import { computed } from 'vue';

const props = defineProps<{
  clip: Clip;
  pixelsPerFrame: number;
  selected: boolean;
  trackLocked: boolean;
  trackHeight: number;
}>();

const emit = defineEmits<{
  select: [clipId: string];
  change: [payload: { start: number; duration: number }];
  commit: [payload: { start: number; duration: number }];
}>();

const left = computed(() => props.clip.start * props.pixelsPerFrame);
const width = computed(() => Math.max(4, props.clip.duration * props.pixelsPerFrame));

const { begin } = useDragResize({
  pixelsPerFrame: () => props.pixelsPerFrame,
  minDurationFrames: 4,
  onChange: (next) => emit('change', next),
  onCommit: (next) => emit('commit', next),
});

function onPointerDown(event: PointerEvent, mode: 'move' | 'resize-left' | 'resize-right'): void {
  if (props.trackLocked) return;
  event.stopPropagation();
  emit('select', props.clip.id);
  begin(event, mode, { start: props.clip.start, duration: props.clip.duration });
}

const typeLabel = computed(() => props.clip.type.toUpperCase());

/**
 * Deterministic bar heights (0.15–1) for the audio waveform, derived from the
 * clip id so a given clip always renders the same shape without needing real
 * PCM analysis. Uses clip.waveform when the backend provides it.
 */
const WAVE_BARS = 64;
const waveform = computed<number[]>(() => {
  if (props.clip.waveform?.length) return props.clip.waveform;
  const seedBase = props.clip.id;
  const bars: number[] = [];
  for (let i = 0; i < WAVE_BARS; i += 1) {
    let h = 0;
    for (let k = 0; k < seedBase.length; k += 1) {
      h += seedBase.charCodeAt(k) * ((i % 7) + 1) * (k + 3);
    }
    const norm = (Math.sin(h) + 1) / 2; // 0..1
    bars.push(0.18 + norm * 0.82);
  }
  return bars;
});

const isAudio = computed(() => props.clip.type === 'audio');
const isVideo = computed(() => props.clip.type === 'video');
const isFx = computed(() => props.clip.type === 'fx');
</script>

<template>
  <div
    class="group absolute top-1 flex select-none flex-col overflow-hidden rounded-md border transition-shadow"
    :style="{
      left: `${left}px`,
      width: `${width}px`,
      height: `${trackHeight - 8}px`,
      backgroundColor: isFx ? `${clip.color}22` : `${clip.color}1f`,
      borderColor: selected ? clip.color : `${clip.color}66`,
    }"
    :class="[trackLocked ? 'cursor-not-allowed opacity-60' : 'cursor-grab active:cursor-grabbing']"
    @pointerdown="onPointerDown($event, 'move')"
  >
    <div
      class="pointer-events-none absolute inset-0 rounded-md"
      :style="selected ? { boxShadow: `0 0 0 1.5px ${clip.color}, 0 0 16px ${clip.color}88` } : {}"
    />

    <!-- Audio: green waveform -->
    <template v-if="isAudio">
      <div class="flex items-center gap-1 px-1.5 pt-1 text-[10px] font-medium leading-none" :style="{ color: clip.color }">
        <span class="truncate">{{ clip.name }}</span>
      </div>
      <div class="flex flex-1 items-center gap-px overflow-hidden px-1 pb-1">
        <span
          v-for="(h, i) in waveform"
          :key="i"
          class="min-w-[1px] flex-1 rounded-[1px]"
          :style="{ height: `${Math.round(h * 100)}%`, backgroundColor: clip.color, opacity: 0.85 }"
        />
      </div>
    </template>

    <!-- FX: badge chip -->
    <template v-else-if="isFx">
      <div class="flex h-full items-center gap-1 px-1.5" :style="{ color: clip.color }">
        <SparklesIcon class="h-3 w-3 shrink-0" />
        <span class="truncate text-[10px] font-semibold">{{ clip.name }}</span>
      </div>
    </template>

    <!-- Video: filmstrip -->
    <template v-else-if="isVideo">
      <div
        v-if="clip.thumbnail"
        class="pointer-events-none absolute inset-0"
        :style="{ backgroundImage: `url(${clip.thumbnail})`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x', backgroundPosition: 'left center' }"
      />
      <div
        class="pointer-events-none absolute inset-0 opacity-40"
        style="background-image: repeating-linear-gradient(90deg, rgba(255,255,255,0.10) 0 2px, transparent 2px 14px), repeating-linear-gradient(0deg, rgba(0,0,0,0.35) 0 3px, transparent 3px 10px)"
      />
      <div class="relative flex items-center gap-1 px-1.5 pt-1 text-[10px] font-medium leading-none text-white/90">
        <span class="truncate rounded bg-black/40 px-1">{{ clip.name }}</span>
      </div>
      <span class="absolute bottom-1 left-1.5 text-[9px] uppercase tracking-wider text-white/50">{{ typeLabel }}</span>
    </template>

    <!-- Title / image / other -->
    <template v-else>
      <div class="flex items-center gap-1 px-1.5 pt-1 text-[10px] font-medium leading-none" :style="{ color: clip.color }">
        <span class="truncate">{{ clip.name }}</span>
      </div>
      <span class="absolute bottom-1 left-1.5 text-[9px] uppercase tracking-wider text-slate-500">{{ typeLabel }}</span>
    </template>

    <!-- Trim handles (always visible; brighter for the selected clip) -->
    <div
      v-if="!trackLocked"
      class="absolute inset-y-0 left-0 z-20 flex w-2 cursor-ew-resize items-center justify-center rounded-l-md border-r border-black/30 transition-opacity"
      :class="selected ? 'opacity-100' : 'opacity-70 group-hover:opacity-100'"
      :style="{ backgroundColor: clip.color }"
      title="Trim start"
      @pointerdown="onPointerDown($event, 'resize-left')"
    >
      <span class="h-3 w-0.5 rounded-full bg-black/50" />
    </div>
    <div
      v-if="!trackLocked"
      class="absolute inset-y-0 right-0 z-20 flex w-2 cursor-ew-resize items-center justify-center rounded-r-md border-l border-black/30 transition-opacity"
      :class="selected ? 'opacity-100' : 'opacity-70 group-hover:opacity-100'"
      :style="{ backgroundColor: clip.color }"
      title="Trim end"
      @pointerdown="onPointerDown($event, 'resize-right')"
    >
      <span class="h-3 w-0.5 rounded-full bg-black/50" />
    </div>
  </div>
</template>
