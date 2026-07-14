<script setup lang="ts">
/**
 * Landing dashboard: project overview, system status tiles, and
 * quick links into the main workflows.
 */
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import {
  ChartBarIcon,
  CpuChipIcon,
  FilmIcon,
  SignalIcon,
  Squares2X2Icon,
  VideoCameraIcon,
} from '@heroicons/vue/24/outline';
import { onMounted } from 'vue';
import { RouterLink } from 'vue-router';

const projectStore = useProjectStore();
const timelineStore = useTimelineStore();

onMounted(async () => {
  await Promise.all([projectStore.fetchProject(), projectStore.fetchStatus(), timelineStore.fetchTimeline()]);
});

const quickLinks = [
  { to: '/editor', label: 'Open Live Editor', icon: Squares2X2Icon, accent: 'from-emerald-400 to-teal-500' },
  { to: '/media', label: 'Browse Media', icon: FilmIcon, accent: 'from-teal-400 to-emerald-500' },
  { to: '/capture', label: 'Start Capture', icon: VideoCameraIcon, accent: 'from-emerald-500 to-teal-400' },
];
</script>

<template>
  <div class="h-full overflow-y-auto p-6">
    <header class="mb-6">
      <h1 class="text-2xl font-semibold text-slate-100">{{ projectStore.projectName }}</h1>
      <p class="text-sm text-slate-500">Broadcast production overview</p>
    </header>

    <div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
      <div class="rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel">
        <div class="mb-2 flex items-center gap-2 text-slate-500">
          <SignalIcon class="h-4 w-4 text-emerald-400" />
          <span class="text-[11px] uppercase tracking-widest">Connection</span>
        </div>
        <p class="text-lg font-semibold" :class="projectStore.status.connected ? 'text-emerald-300' : 'text-rose-400'">
          {{ projectStore.status.connected ? 'Online' : 'Offline' }}
        </p>
      </div>
      <div class="rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel">
        <div class="mb-2 flex items-center gap-2 text-slate-500">
          <CpuChipIcon class="h-4 w-4 text-teal-400" />
          <span class="text-[11px] uppercase tracking-widest">CPU</span>
        </div>
        <p class="text-lg font-semibold text-slate-200">{{ Math.round(projectStore.status.cpuUsage) }}%</p>
      </div>
      <div class="rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel">
        <div class="mb-2 flex items-center gap-2 text-slate-500">
          <ChartBarIcon class="h-4 w-4 text-teal-400" />
          <span class="text-[11px] uppercase tracking-widest">Memory</span>
        </div>
        <p class="text-lg font-semibold text-slate-200">{{ Math.round(projectStore.status.memoryUsage) }}%</p>
      </div>
      <div class="rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel">
        <div class="mb-2 flex items-center gap-2 text-slate-500">
          <FilmIcon class="h-4 w-4 text-emerald-400" />
          <span class="text-[11px] uppercase tracking-widest">Media Assets</span>
        </div>
        <p class="text-lg font-semibold text-slate-200">{{ projectStore.mediaAssets.length }}</p>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
      <RouterLink
        v-for="link in quickLinks"
        :key="link.to"
        :to="link.to"
        class="group flex items-center gap-3 rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel transition hover:border-emerald-500/30 hover:shadow-glow"
      >
        <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br text-surface-950" :class="link.accent">
          <component :is="link.icon" class="h-5 w-5" />
        </div>
        <span class="text-sm font-medium text-slate-200 group-hover:text-emerald-300">{{ link.label }}</span>
      </RouterLink>
    </div>

    <div class="mt-6 rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">Project Details</h2>
      <dl class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div>
          <dt class="text-[11px] text-slate-500">Resolution</dt>
          <dd class="font-mono text-slate-300">{{ projectStore.project?.resolution ?? '—' }}</dd>
        </div>
        <div>
          <dt class="text-[11px] text-slate-500">Frame Rate</dt>
          <dd class="font-mono text-slate-300">{{ projectStore.project?.fps ?? '—' }}</dd>
        </div>
        <div>
          <dt class="text-[11px] text-slate-500">Timeline Duration</dt>
          <dd class="font-mono text-slate-300">{{ timelineStore.duration }} frames</dd>
        </div>
        <div>
          <dt class="text-[11px] text-slate-500">Tracks</dt>
          <dd class="font-mono text-slate-300">{{ timelineStore.tracks.length }}</dd>
        </div>
      </dl>
    </div>
  </div>
</template>
