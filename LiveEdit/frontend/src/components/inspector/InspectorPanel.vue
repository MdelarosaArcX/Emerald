<script setup lang="ts">
/**
 * Right-hand drawer showing editable properties of the selected clip:
 * transform, playback, audio, and applied effects.
 */
import { useTimecode } from '@/composables/useTimecode';
import { useTimelineStore } from '@/stores/timelineStore';
import { AdjustmentsHorizontalIcon, SparklesIcon } from '@heroicons/vue/24/outline';
import { computed } from 'vue';

const timelineStore = useTimelineStore();
const { framesToTimecode } = useTimecode(timelineStore.fps);

const clip = computed(() => timelineStore.selectedClip);

function updateNumber(field: 'opacity' | 'rotation' | 'scale' | 'speed' | 'volume', event: Event): void {
  if (!clip.value) return;
  const value = Number((event.target as HTMLInputElement).value);
  timelineStore.updateClip(clip.value.id, { [field]: value });
}

function updatePosition(axis: 'x' | 'y', event: Event): void {
  if (!clip.value) return;
  const value = Number((event.target as HTMLInputElement).value);
  const position = { ...(clip.value.position ?? { x: 0, y: 0 }), [axis]: value };
  timelineStore.updateClip(clip.value.id, { position });
}
</script>

<template>
  <aside class="flex h-full w-72 shrink-0 flex-col gap-3 rounded-xl border border-white/5 bg-surface-900/80 p-3 shadow-panel">
    <header class="flex items-center gap-1.5">
      <AdjustmentsHorizontalIcon class="h-4 w-4 text-teal-400" />
      <h2 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Inspector</h2>
    </header>

    <div v-if="!clip" class="flex flex-1 items-center justify-center text-center text-xs text-slate-600">
      Select a clip on the timeline to inspect its properties.
    </div>

    <div v-else class="flex-1 space-y-4 overflow-y-auto pr-1 text-xs">
      <div class="rounded-lg border border-white/5 bg-surface-850/60 p-3">
        <div class="mb-2 flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: clip.color }" />
          <span class="truncate text-sm font-semibold text-slate-100">{{ clip.name }}</span>
        </div>
        <dl class="grid grid-cols-2 gap-y-1.5 font-mono text-[11px] text-slate-400">
          <dt>Start</dt>
          <dd class="text-right text-slate-300">{{ framesToTimecode(clip.start) }}</dd>
          <dt>End</dt>
          <dd class="text-right text-slate-300">{{ framesToTimecode(clip.start + clip.duration) }}</dd>
          <dt>Duration</dt>
          <dd class="text-right text-slate-300">{{ framesToTimecode(clip.duration) }}</dd>
        </dl>
      </div>

      <div class="space-y-3 rounded-lg border border-white/5 bg-surface-850/60 p-3">
        <h3 class="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Transform</h3>

        <label class="block space-y-1">
          <div class="flex justify-between"><span class="text-slate-500">Opacity</span><span class="text-slate-300">{{ clip.opacity }}%</span></div>
          <input type="range" min="0" max="100" class="w-full accent-emerald-400" :value="clip.opacity" @input="updateNumber('opacity', $event)" />
        </label>

        <label class="block space-y-1">
          <div class="flex justify-between"><span class="text-slate-500">Rotation</span><span class="text-slate-300">{{ clip.rotation }}°</span></div>
          <input type="range" min="-180" max="180" class="w-full accent-emerald-400" :value="clip.rotation" @input="updateNumber('rotation', $event)" />
        </label>

        <label class="block space-y-1">
          <div class="flex justify-between"><span class="text-slate-500">Scale</span><span class="text-slate-300">{{ clip.scale }}%</span></div>
          <input type="range" min="10" max="400" class="w-full accent-emerald-400" :value="clip.scale" @input="updateNumber('scale', $event)" />
        </label>

        <div class="grid grid-cols-2 gap-2">
          <label class="block space-y-1">
            <span class="text-slate-500">Position X</span>
            <input
              type="number"
              class="w-full rounded border border-white/10 bg-surface-800 px-1.5 py-1 text-slate-200 focus:border-emerald-500/50 focus:outline-none"
              :value="clip.position?.x ?? 0"
              @input="updatePosition('x', $event)"
            />
          </label>
          <label class="block space-y-1">
            <span class="text-slate-500">Position Y</span>
            <input
              type="number"
              class="w-full rounded border border-white/10 bg-surface-800 px-1.5 py-1 text-slate-200 focus:border-emerald-500/50 focus:outline-none"
              :value="clip.position?.y ?? 0"
              @input="updatePosition('y', $event)"
            />
          </label>
        </div>
      </div>

      <div class="space-y-3 rounded-lg border border-white/5 bg-surface-850/60 p-3">
        <h3 class="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Playback</h3>

        <label class="block space-y-1">
          <div class="flex justify-between"><span class="text-slate-500">Speed</span><span class="text-slate-300">{{ clip.speed }}x</span></div>
          <input type="range" min="0.1" max="4" step="0.1" class="w-full accent-teal-400" :value="clip.speed" @input="updateNumber('speed', $event)" />
        </label>

        <label class="block space-y-1">
          <div class="flex justify-between"><span class="text-slate-500">Volume</span><span class="text-slate-300">{{ clip.volume }}%</span></div>
          <input type="range" min="0" max="100" class="w-full accent-teal-400" :value="clip.volume" @input="updateNumber('volume', $event)" />
        </label>
      </div>

      <div class="space-y-2 rounded-lg border border-white/5 bg-surface-850/60 p-3">
        <h3 class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
          <SparklesIcon class="h-3.5 w-3.5 text-emerald-400" />
          Effects
        </h3>
        <ul v-if="clip.effects.length" class="space-y-1">
          <li
            v-for="effect in clip.effects"
            :key="effect.id"
            class="flex items-center justify-between rounded border border-white/5 bg-surface-800 px-2 py-1.5"
          >
            <span class="text-slate-300">{{ effect.name }}</span>
            <span class="rounded-full px-1.5 py-0.5 text-[9px]" :class="effect.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-slate-500'">
              {{ effect.enabled ? 'ON' : 'OFF' }}
            </span>
          </li>
        </ul>
        <p v-else class="text-slate-600">No effects applied.</p>
      </div>
    </div>
  </aside>
</template>
