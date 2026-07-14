<script setup lang="ts">
/**
 * Application shell: toolbar, left navigation, routed view, and the
 * global notification stack.
 */
import AppToolbar from '@/components/toolbar/AppToolbar.vue';
import NotificationCenter from '@/components/notifications/NotificationCenter.vue';
import ProjectSidebar from '@/components/sidebar/ProjectSidebar.vue';
import StatusBar from '@/components/status/StatusBar.vue';
import { useProjectStore } from '@/stores/projectStore';
import { useIntervalFn } from '@vueuse/core';
import { onMounted } from 'vue';

const projectStore = useProjectStore();

onMounted(() => {
  projectStore.fetchStatus();
});

useIntervalFn(() => {
  projectStore.fetchStatus();
}, 4000);
</script>

<template>
  <div class="flex h-screen w-screen flex-col overflow-hidden bg-surface-950 text-slate-200">
    <AppToolbar />
    <div class="flex min-h-0 flex-1">
      <ProjectSidebar />
      <main class="min-w-0 flex-1 overflow-hidden">
        <RouterView />
      </main>
    </div>
    <StatusBar />
    <NotificationCenter />
  </div>
</template>
