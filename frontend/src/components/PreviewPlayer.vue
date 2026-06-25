<script setup lang="ts">
import Hls from "hls.js";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import mediaStill from "../assets/reference-media.png";

const props = defineProps<{
  src: string;
  variant?: "library" | "capture";
  title?: string;
  description?: string;
  detail?: string;
  sourceUrl?: string;
  isRecording?: boolean;
  timecode?: string;
  transportLabel?: string;
  durationLabel?: string;
  fpsLabel?: string;
  formatLabel?: string;
  isBusy?: boolean;
}>();

const emit = defineEmits<{
  start: [];
  stop: [];
  configure: [];
}>();

const video = ref<HTMLVideoElement | null>(null);
const hasPlayback = ref(false);
let hls: Hls | null = null;

const mode = computed(() => props.variant || "library");
const isCapture = computed(() => mode.value === "capture");
const showSourcePrompt = computed(() => isCapture.value && !props.isRecording && !hasPlayback.value);

watch(() => props.src, loadSource, { immediate: true });

onBeforeUnmount(() => {
  hls?.destroy();
});

async function loadSource(src: string) {
  if (!video.value) return;

  hasPlayback.value = false;
  hls?.destroy();
  hls = null;
  video.value.removeAttribute("src");
  video.value.load();

  if (!src) return;

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

function onPlaying() {
  hasPlayback.value = true;
}

function onVideoError() {
  hasPlayback.value = false;
}
</script>

<template>
  <section class="preview-panel" :class="mode">
    <div v-if="isCapture" class="timecode">{{ timecode || "00:00:00:00" }}</div>
    <div class="video-frame">
      <video
        ref="video"
        autoplay
        muted
        playsinline
        :poster="isCapture ? undefined : mediaStill"
        @playing="onPlaying"
        @error="onVideoError"
      ></video>
      <button
        v-if="showSourcePrompt"
        type="button"
        class="source-prompt"
        aria-label="Configure source"
        @click="emit('configure')"
      >
        <span class="source-prompt-icon" aria-hidden="true"></span>
        <span>Click to configure source</span>
      </button>
      <div v-if="mode === 'library'" class="media-meta">
        <dl>
          <div>
            <dt>Title</dt>
            <dd>{{ title || "No recorded segment selected" }}</dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>{{ description || "OBS recordings saved by the backend will preview here." }}</dd>
          </div>
          <div>
            <dt>Details</dt>
            <dd>{{ detail || "--" }}</dd>
          </div>
        </dl>
      </div>
    </div>

    <div class="transport" :class="{ recording: isCapture }">
      <span v-if="isCapture && isRecording" class="record-label">
        <i></i> {{ transportLabel || "Recording ..." }}
      </span>
      <button
        type="button"
        class="pause active"
        :class="{ play: isCapture && !isRecording }"
        :disabled="isCapture && (isBusy || isRecording)"
        :aria-label="isCapture ? 'Start encoding' : 'Pause'"
        @click="isCapture && !isRecording ? emit('start') : undefined"
      ></button>
      <button
        type="button"
        class="stop"
        :disabled="isCapture && (isBusy || !isRecording)"
        aria-label="Stop encoding"
        @click="isCapture && isRecording ? emit('stop') : undefined"
      ></button>
      <button v-if="mode === 'library'" type="button" class="previous" aria-label="Previous"></button>
      <button v-if="mode === 'library'" type="button" class="next" aria-label="Next"></button>
      <button v-if="mode === 'library'" type="button" class="rewind" aria-label="Rewind"></button>
      <button v-if="mode === 'library'" type="button" class="forward" aria-label="Forward"></button>
      <button v-if="mode === 'library'" type="button" class="disabled-icon" aria-label="Disable"></button>
      <button v-if="mode === 'library'" type="button" class="cut" aria-label="Cut"></button>
      <button type="button" class="fullscreen" aria-label="Fullscreen"></button>
      <button v-if="isCapture" type="button" class="settings" aria-label="Settings" @click="emit('configure')"></button>
    </div>

    <dl v-if="isCapture" class="capture-meta">
      <div>
        <dt>Source URL/path</dt>
        <dd>{{ sourceUrl || "--" }}</dd>
      </div>
      <div>
        <dt>Title</dt>
        <dd>{{ title || "OBS live preview" }}</dd>
      </div>
      <div>
        <dt>Description</dt>
        <dd>{{ description || "The right video frame shows the stream currently being published from OBS." }}</dd>
      </div>
      <div>
        <dt>Duration | FPS</dt>
        <dd>{{ detail || "--" }}</dd>
      </div>
      <div>
        <dt>Format</dt>
        <dd>{{ formatLabel || "MP4 | H.264 | AAC" }}</dd>
      </div>
    </dl>
  </section>
</template>
