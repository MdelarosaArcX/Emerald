<script setup lang="ts">
/**
 * Live Edit mode right column: the video / audio effects palette. Effects apply
 * to the currently selected timeline clip — clicking a chip toggles that effect
 * on the clip (added to / removed from its `effects` list).
 */
import { useTimelineStore } from '@/stores/timelineStore';
import type { ClipEffect } from '@/types/clip';
import { ChevronDownIcon, SparklesIcon, SpeakerWaveIcon } from '@heroicons/vue/24/outline';
import { computed, ref } from 'vue';

const timelineStore = useTimelineStore();
const clip = computed(() => timelineStore.selectedClip);

const videoEffects = ['Blur', 'Motion Blur', 'Face Blur'];
const audioEffects = ['Mute', 'Remove Noise'];

const videoOpen = ref(true);
const audioOpen = ref(true);

function isActive(name: string): boolean {
  return clip.value?.effects.some((e) => e.name === name) ?? false;
}

function toggleEffect(name: string): void {
  if (!clip.value) return;
  const has = clip.value.effects.some((e) => e.name === name);
  const effects: ClipEffect[] = has
    ? clip.value.effects.filter((e) => e.name !== name)
    : [...clip.value.effects, { id: `${name.replace(/\s+/g, '-').toLowerCase()}-${clip.value.effects.length}`, name, enabled: true, params: {} }];
  timelineStore.updateClip(clip.value.id, { effects });
}
</script>

<template>
  <aside class="flex h-full w-full min-w-0 flex-col gap-3 rounded-xl border border-white/5 bg-surface-900/80 p-3 shadow-panel">
    <header class="flex items-center gap-1.5">
      <SparklesIcon class="h-4 w-4 text-emerald-400" />
      <h2 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Effects</h2>
    </header>

    <p v-if="!clip" class="rounded-md border border-white/5 bg-surface-850/60 px-2.5 py-2 text-[0.6875rem] text-slate-500">
      Select a clip on the timeline to apply effects.
    </p>

    <div class="flex-1 space-y-3 overflow-y-auto pr-1">
      <!-- Video effects -->
      <section class="rounded-lg border border-white/5 bg-surface-850/60">
        <button
          class="flex w-full items-center gap-1.5 px-3 py-2 text-[0.6875rem] font-semibold uppercase tracking-widest text-slate-400 transition hover:text-slate-200"
          @click="videoOpen = !videoOpen"
        >
          <ChevronDownIcon class="h-3.5 w-3.5 transition" :class="{ '-rotate-90': !videoOpen }" />
          Video effects
        </button>
        <div v-show="videoOpen" class="flex flex-wrap gap-2 px-3 pb-3">
          <button
            v-for="fx in videoEffects"
            :key="fx"
            class="rounded-md border px-2.5 py-1 text-[0.6875rem] font-medium transition"
            :class="isActive(fx)
              ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-200'
              : 'border-white/10 bg-surface-800 text-slate-300 hover:border-emerald-500/40 hover:text-emerald-200'"
            :disabled="!clip"
            @click="toggleEffect(fx)"
          >
            {{ fx }}
          </button>
        </div>
      </section>

      <!-- Audio effects -->
      <section class="rounded-lg border border-white/5 bg-surface-850/60">
        <button
          class="flex w-full items-center gap-1.5 px-3 py-2 text-[0.6875rem] font-semibold uppercase tracking-widest text-slate-400 transition hover:text-slate-200"
          @click="audioOpen = !audioOpen"
        >
          <ChevronDownIcon class="h-3.5 w-3.5 transition" :class="{ '-rotate-90': !audioOpen }" />
          <SpeakerWaveIcon class="h-3.5 w-3.5 text-teal-400" />
          Audio effects
        </button>
        <div v-show="audioOpen" class="flex flex-wrap gap-2 px-3 pb-3">
          <button
            v-for="fx in audioEffects"
            :key="fx"
            class="rounded-md border px-2.5 py-1 text-[0.6875rem] font-medium transition"
            :class="isActive(fx)
              ? 'border-teal-400/60 bg-teal-400/15 text-teal-200'
              : 'border-white/10 bg-surface-800 text-slate-300 hover:border-teal-500/40 hover:text-teal-200'"
            :disabled="!clip"
            @click="toggleEffect(fx)"
          >
            {{ fx }}
          </button>
        </div>
      </section>
    </div>
  </aside>
</template>
