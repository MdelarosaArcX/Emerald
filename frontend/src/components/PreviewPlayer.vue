<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import mediaStill from "../assets/reference-media.png";
import settingsIcon from "../assets/icons/settings.png";

const props = defineProps<{
  src: string;
  variant?: "library" | "capture";
  title?: string;
  description?: string;
  detail?: string;
  sourceUrl?: string;
  outputPath?: string;
  videoBitrateLabel?: string;
  audioBitrateLabel?: string;
  sampleFrequencyLabel?: string;
  ffmpegPath?: string;
  isRecording?: boolean;
  timecode?: string;
  transportLabel?: string;
  durationLabel?: string;
  fpsLabel?: string;
  formatLabel?: string;
  isBusy?: boolean;
  splitView?: boolean;
}>();

const emit = defineEmits<{
  start: [];
  stop: [];
  configure: [];
  toggleSplitView: [];
}>();

const video = ref<HTMLVideoElement | null>(null);
const hasPlayback = ref(false);

let pc: RTCPeerConnection | null = null;
let webrtcSessionUrl: string | null = null;
let abortController: AbortController | null = null;

const mode = computed(() => props.variant || "library");
const isCapture = computed(() => mode.value === "capture");
const showSourcePrompt = computed(() => isCapture.value && !props.isRecording && !hasPlayback.value);

watch(() => props.src, loadSource, { immediate: true });

onBeforeUnmount(() => {
  teardownWebrtc();
});

async function loadSource(src: string) {
  if (!video.value) return;

  hasPlayback.value = false;
  teardownWebrtc();
  video.value.srcObject = null;
  video.value.removeAttribute("src");
  video.value.load();

  if (!src) return;

  if (src.includes("/whep")) {
    connectWebrtc(src);
  } else {
    video.value.src = src;
  }
}

function teardownWebrtc() {
  abortController?.abort();
  abortController = null;

  if (pc) {
    pc.close();
    pc = null;
  }

  if (webrtcSessionUrl) {
    fetch(webrtcSessionUrl, { method: "DELETE" }).catch(() => {});
    webrtcSessionUrl = null;
  }
}

async function connectWebrtc(whepUrl: string) {
  const ac = new AbortController();
  abortController = ac;

  const connection = new RTCPeerConnection();
  pc = connection;

  connection.addTransceiver("video", { direction: "recvonly" });

  connection.ontrack = (event) => {
    if (video.value) {
      video.value.srcObject = event.streams[0];
    }
  };

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);

  for (let attempt = 0; attempt < 20; attempt++) {
    if (ac.signal.aborted) return;

    let response: Response | null = null;
    try {
      response = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: connection.localDescription!.sdp,
        signal: ac.signal,
      });
    } catch {
      return;
    }

    if (response.ok) {
      const answerSdp = await response.text();
      const location = response.headers.get("Location");
      webrtcSessionUrl = location ? new URL(location, whepUrl).toString() : null;
      await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
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
      <button
        v-if="mode === 'library'"
        type="button"
        class="split-view"
        :class="{ active: splitView }"
        aria-label="Toggle clip split view"
        :aria-pressed="Boolean(splitView)"
        @click="emit('toggleSplitView')"
      >
        <span aria-hidden="true"></span>
      </button>
      <button v-if="isCapture" type="button" class="settings" aria-label="Settings" @click="emit('configure')">
        <img :src="settingsIcon" alt="" aria-hidden="true" />
      </button>
    </div>

    <dl v-if="isCapture" class="capture-meta">
      <div>
        <dt>Source URL</dt>
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
        <dt>Output path</dt>
        <dd>{{ outputPath || "--" }}</dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>{{ durationLabel || detail || "--" }}</dd>
      </div>
      <div>
        <dt>FPS</dt>
        <dd>{{ fpsLabel || "--" }}</dd>
      </div>
      <div>
        <dt>Format</dt>
        <dd>{{ formatLabel || "MP4 | H.264 | AAC" }}</dd>
      </div>
      <div>
        <dt>Video Bitrate</dt>
        <dd>{{ videoBitrateLabel || "--" }}</dd>
      </div>
      <div>
        <dt>Audio Bitrate</dt>
        <dd>{{ audioBitrateLabel || "--" }}</dd>
      </div>
      <div>
        <dt>Sample Frequency</dt>
        <dd>{{ sampleFrequencyLabel || "--" }}</dd>
      </div>
      <div>
        <dt>FFmpeg Path</dt>
        <dd>{{ ffmpegPath || "--" }}</dd>
      </div>
    </dl>
  </section>
</template>
