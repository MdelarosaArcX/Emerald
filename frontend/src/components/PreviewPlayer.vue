<script setup lang="ts">
import Hls from "hls.js";
import { onBeforeUnmount, ref, watch } from "vue";
import mediaStill from "../assets/reference-media.png";

const props = defineProps<{
  src: string;
  variant?: "library" | "capture";
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
  <section class="preview-panel" :class="variant || 'library'">
    <div v-if="(variant || 'library') === 'capture'" class="timecode">03:28:03:15</div>
    <div class="video-frame">
      <video ref="video" autoplay muted playsinline :poster="mediaStill"></video>
      <div v-if="(variant || 'library') === 'library'" class="media-meta">
        <dl>
          <div>
            <dt>Title</dt>
            <dd>ukraine_russia_drone_attack_20260401.mp4</dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>Archival clip of Russian daytime drone attack on Ukrainian targets resulting in casualties</dd>
          </div>
          <div>
            <dt>Duration | FPS</dt>
            <dd>00:02:30:50 | 25.5 DVB-T</dd>
          </div>
        </dl>
      </div>
    </div>

    <div class="transport" :class="{ recording: (variant || 'library') === 'capture' }">
      <span v-if="(variant || 'library') === 'capture'" class="record-label">
        <i></i> Recording ...
      </span>
      <button type="button" class="pause active" aria-label="Pause"></button>
      <button type="button" class="stop" aria-label="Stop"></button>
      <button v-if="(variant || 'library') === 'library'" type="button" class="previous" aria-label="Previous"></button>
      <button v-if="(variant || 'library') === 'library'" type="button" class="next" aria-label="Next"></button>
      <button v-if="(variant || 'library') === 'library'" type="button" class="rewind" aria-label="Rewind"></button>
      <button v-if="(variant || 'library') === 'library'" type="button" class="forward" aria-label="Forward"></button>
      <button v-if="(variant || 'library') === 'library'" type="button" class="disabled-icon" aria-label="Disable"></button>
      <button v-if="(variant || 'library') === 'library'" type="button" class="cut" aria-label="Cut"></button>
      <button type="button" class="fullscreen" aria-label="Fullscreen"></button>
      <button v-if="(variant || 'library') === 'capture'" type="button" class="settings" aria-label="Settings"></button>
    </div>

    <dl v-if="(variant || 'library') === 'capture'" class="capture-meta">
      <div>
        <dt>Source URL/path</dt>
        <dd>rtmp://10.0.0.25/test/1</dd>
      </div>
      <div>
        <dt>Title</dt>
        <dd>ukraine_russia_drone_attack_20260401.mp4</dd>
      </div>
      <div>
        <dt>Description</dt>
        <dd>Archival clip of Russian daytime drone attack on Ukrainian targets resulting in casualties</dd>
      </div>
      <div>
        <dt>Duration | FPS</dt>
        <dd>00:02:30:50 | 25.5 DVB-T</dd>
      </div>
      <div>
        <dt>Format</dt>
        <dd>MP4&nbsp;&nbsp;|&nbsp;&nbsp;H.264&nbsp;&nbsp;|&nbsp;&nbsp;AAC</dd>
      </div>
    </dl>
  </section>
</template>
