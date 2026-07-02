<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import mediaStill from "../assets/reference-media.png";
import settingsIcon from "../assets/icons/settings.png";

const props = defineProps<{
  src: string;
  fps?: number;
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
  startAt?: string;
}>();

const emit = defineEmits<{
  start: [];
  stop: [];
  configure: [];
  toggleSplitView: [];
}>();

const video = ref<HTMLVideoElement | null>(null);
const hasPlayback = ref(false);
const isPaused = ref(true);
const internalTimecode = ref("00:00:00:00");

let pc: RTCPeerConnection | null = null;
let webrtcSessionUrl: string | null = null;
let abortController: AbortController | null = null;
let rafId: number | null = null;

const mode = computed(() => props.variant || "library");
const isCapture = computed(() => mode.value === "capture");
const showSourcePrompt = computed(() => isCapture.value && !props.isRecording && !hasPlayback.value);
const showPlayIcon = computed(() => (isCapture.value ? !props.isRecording : isPaused.value));
const displayTimecode = computed(() => {
  // Capture is a live wall clock driven by the parent (App.vue) — the video
  // element's own currentTime resets to 0 whenever the WebRTC preview reconnects,
  // so it must never be used as the source of truth for capture's timecode.
  if (isCapture.value) return props.timecode || "00:00:00:00";
  if (hasPlayback.value) return internalTimecode.value;
  if (props.startAt) return toWallClockTimecode(new Date(props.startAt).getTime(), props.fps ?? 25);
  return props.timecode || "00:00:00:00";
});

watch(() => props.src, loadSource, { immediate: true });

onBeforeUnmount(() => {
  teardownWebrtc();
  stopTimecodeLoop();
});

async function loadSource(src: string) {
  if (!video.value) return;

  hasPlayback.value = false;
  isPaused.value = true;
  internalTimecode.value = "00:00:00:00";
  teardownWebrtc();
  stopTimecodeLoop();
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

function startTimecodeLoop() {
  if (rafId !== null || isCapture.value) return;

  const tick = () => {
    if (video.value) {
      if (props.startAt) {
        const startedMs = new Date(props.startAt).getTime();
        internalTimecode.value = toWallClockTimecode(startedMs + video.value.currentTime * 1000, props.fps ?? 25);
      } else {
        internalTimecode.value = toTimecode(video.value.currentTime, props.fps ?? 25);
      }
    }
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
}

function stopTimecodeLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function toTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.floor(seconds * fps);
  const frames = totalFrames % fps;
  const totalSecs = Math.floor(totalFrames / fps);
  const ss = totalSecs % 60;
  const mm = Math.floor(totalSecs / 60) % 60;
  const hh = Math.floor(totalSecs / 3600);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(frames)}`;
}

function toWallClockTimecode(ms: number, fps: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "00:00:00:00";

  const frames = Math.floor((date.getMilliseconds() / 1000) * fps);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(frames)}`;
}

function pad(n: number) {
  return String(Math.trunc(n)).padStart(2, "0");
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

  for (let attempt = 0; attempt < 40; attempt++) {
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
      // Aborted means the component unmounted — stop retrying
      if (ac.signal.aborted) return;
      // Network error (connection refused, WHEP not ready yet) — retry
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
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
  isPaused.value = false;
  startTimecodeLoop();
}

function onPause() {
  isPaused.value = true;
  stopTimecodeLoop();
}

function onEnded() {
  hasPlayback.value = false;
  isPaused.value = true;
  stopTimecodeLoop();
}

function onVideoError() {
  hasPlayback.value = false;
  isPaused.value = true;
  stopTimecodeLoop();
}

function togglePlayback() {
  if (isCapture.value) {
    if (!props.isRecording) emit("start");
    return;
  }

  if (!video.value || !props.src) return;

  if (video.value.paused) {
    video.value.play();
  } else {
    video.value.pause();
  }
}
</script>

<template>
  <section class="preview-panel" :class="mode">
    <div class="timecode">{{ displayTimecode }}</div>
    <div class="video-frame">
      <video
        ref="video"
        :autoplay="isCapture"
        muted
        playsinline
        :poster="isCapture ? undefined : mediaStill"
        @playing="onPlaying"
        @pause="onPause"
        @ended="onEnded"
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
        :class="{ play: showPlayIcon }"
        :disabled="isCapture ? (isBusy || isRecording) : !props.src"
        :aria-label="isCapture ? 'Start encoding' : (isPaused ? 'Play' : 'Pause')"
        @click="togglePlayback"
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
        <dd>{{ formatLabel || "MOV | ProRes 422" }}</dd>
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
