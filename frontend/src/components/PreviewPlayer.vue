<script setup lang="ts">
import Hls from "hls.js";
import { onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  src: string;
}>();

const video = ref<HTMLVideoElement | null>(null);
let hls: Hls | null = null;

watch(() => props.src, loadSource, { immediate: true });

onBeforeUnmount(() => {
  hls?.destroy();
});

async function loadSource(src: string) {
  if (!video.value || !src) return;

  hls?.destroy();
  hls = null;
  video.value.removeAttribute("src");

  if (src.includes(".m3u8") && Hls.isSupported()) {
    hls = new Hls({
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 10,
    });
    hls.loadSource(src);
    hls.attachMedia(video.value);
  } else {
    video.value.src = src;
  }
}
</script>

<template>
  <section class="panel preview-panel">
    <video ref="video" autoplay muted playsinline controls></video>
  </section>
</template>
