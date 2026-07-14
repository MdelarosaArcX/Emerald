<script setup lang="ts">
/**
 * Standalone Capture route: dedicated full-size capture workspace.
 */
import CapturePreview from '@/components/capture/CapturePreview.vue';
import { useCaptureStore } from '@/stores/captureStore';
import { onMounted } from 'vue';

const captureStore = useCaptureStore();

onMounted(() => {
  captureStore.subscribeToSocket();
});
</script>

<template>
  <div class="mx-auto h-full max-w-2xl p-3">
    <CapturePreview />
  </div>
</template>
