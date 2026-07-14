<script setup lang="ts">
/**
 * Standalone Media Browser route: full-height media asset grid.
 */
import MediaBrowser from '@/components/media/MediaBrowser.vue';
import { useProjectStore } from '@/stores/projectStore';
import { onMounted } from 'vue';

const projectStore = useProjectStore();

onMounted(() => {
  if (!projectStore.project) projectStore.fetchProject();
});
</script>

<template>
  <div class="h-full p-3">
    <MediaBrowser />
  </div>
</template>
