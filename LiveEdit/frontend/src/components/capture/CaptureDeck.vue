<script setup lang="ts">
/**
 * Left deck container: the rotated edge tabs plus the tabbed panel body.
 * "Capture Preview" shows the live capture monitor; "Media Browser" swaps
 * it in-place for the saved-clips directory grid — tab behavior, no route
 * change so the timeline/monitors stay mounted.
 */
import CapturePreview from '@/components/capture/CapturePreview.vue';
import ClipBrowser from '@/components/media/ClipBrowser.vue';
import { ref } from 'vue';

type LeftTab = 'capture' | 'media';
const activeTab = ref<LeftTab>('capture');

const tabs: { id: LeftTab; label: string }[] = [
  { id: 'capture', label: 'Capture Preview' },
  { id: 'media', label: 'Media Browser' },
];
</script>

<template>
  <div class="flex h-full">
    <!-- Rotated edge tabs — occupy the top half of the panel height -->
    <div class="flex w-8 shrink-0 flex-col justify-start pr-1">
      <div class="flex h-1/2 flex-col items-stretch gap-2">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="flex flex-1 items-center justify-center rounded-l-md border-l-2 text-[11px] font-semibold uppercase tracking-widest transition"
          :class="activeTab === tab.id
            ? 'border-[#5b6ee5] bg-[#5b6ee5] text-white shadow-glow-teal'
            : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'"
          style="writing-mode: vertical-rl; transform: rotate(180deg)"
          :title="tab.label"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <CapturePreview v-show="activeTab === 'capture'" />
    <ClipBrowser v-if="activeTab === 'media'" gallery />
  </div>
</template>
