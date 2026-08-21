<script setup lang="ts">
/**
 * Left navigation sidebar: primary route links plus a compact
 * project summary block.
 */
import { useProjectStore } from '@/stores/projectStore';
import {
  Cog6ToothIcon,
  FilmIcon,
  HomeIcon,
  PlayCircleIcon,
  Squares2X2Icon,
  VideoCameraIcon,
} from '@heroicons/vue/24/outline';
import { RouterLink } from 'vue-router';

const projectStore = useProjectStore();

const links = [
  { to: '/', label: 'Dashboard', icon: HomeIcon },
  { to: '/editor', label: 'Live Editor', icon: Squares2X2Icon },
  { to: '/media', label: 'Media Browser', icon: FilmIcon },
  { to: '/capture', label: 'Capture', icon: VideoCameraIcon },
  { to: '/playback', label: 'Playback', icon: PlayCircleIcon },
  { to: '/settings', label: 'Settings', icon: Cog6ToothIcon },
];
</script>

<template>
  <nav class="flex h-full w-16 shrink-0 flex-col items-center gap-2 border-r border-white/5 bg-surface-900/90 py-3">
    <RouterLink
      v-for="link in links"
      :key="link.to"
      :to="link.to"
      class="group relative flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/5 hover:text-emerald-300"
      active-class="!bg-emerald-500/10 !text-emerald-300 shadow-glow"
      :title="link.label"
    >
      <component :is="link.icon" class="h-5 w-5" />
      <span
        class="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-md border border-white/5 bg-surface-800 px-2 py-1 text-[0.6875rem] text-slate-200 opacity-0 shadow-panel transition group-hover:opacity-100"
      >
        {{ link.label }}
      </span>
    </RouterLink>

    <div class="mt-auto flex flex-col items-center gap-1 px-1 text-center">
      <span
        class="h-1.5 w-1.5 rounded-full"
        :class="projectStore.status.connected ? 'bg-emerald-400 animate-pulseGlow' : 'bg-rose-500'"
      />
      <span class="text-[0.5625rem] text-slate-600">v1.0</span>
    </div>
  </nav>
</template>
