<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import settingsIcon from "../assets/icons/settings.png";

const props = defineProps<{
  src: string;
  fps?: number;
  variant?: "library" | "capture" | "broadcast";
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
  showPutOnAir?: boolean;
  canPutOnAir?: boolean;
}>();

const emit = defineEmits<{
  start: [];
  stop: [];
  configure: [];
  toggleSplitView: [];
  putOnAir: [];
}>();

const video = ref<HTMLVideoElement | null>(null);
const hasPlayback = ref(false);
const isPaused = ref(true);
const internalTimecode = ref("00:00:00:00");
// Whether the WebRTC connection is actually receiving audio RTP packets right now — not just
// whether an audio track/transceiver exists. A transceiver negotiates fine even when the
// publisher never sends real audio (e.g. before the SDI audio pipeline exists at all), so
// presence has to be measured from live stats, not inferred from the SDP.
const audioDetected = ref(false);

let pc: RTCPeerConnection | null = null;
let webrtcSessionUrl: string | null = null;
let abortController: AbortController | null = null;
let rafId: number | null = null;
let reconnectTimer: number | null = null;
let stallWatchdogHandle: number | null = null;
let audioStatsHandle: number | null = null;
let lastAudioPacketsReceived = 0;
let lastFrameTime = -1;
let lastFrameProgressAt = 0;

const STALL_TIMEOUT_MS = 8000;
const STALL_CHECK_INTERVAL_MS = 2000;
const AUDIO_STATS_INTERVAL_MS = 2000;

const mode = computed(() => props.variant || "library");
// "capture" and "broadcast" are both live, wall-clock-driven decks — they only differ in the
// meta fields shown below the transport bar (recording config vs. broadcast destination).
const isCapture = computed(() => mode.value === "capture" || mode.value === "broadcast");
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

watch(() => props.src, loadSource);

// Background/inactive browser tabs throttle timers and can leave the decoder in a
// frozen state — WebRTC's own reconnect logic can't reliably detect this since even
// the stall-watchdog interval gets throttled. Force a clean reconnect the moment the
// tab becomes visible again instead of waiting for the user to manually refresh.
function handleVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  if (!props.src || !props.src.includes("/whep")) return;

  teardownWebrtc();
  connectWebrtc(props.src);
}

onMounted(() => {
  document.addEventListener("visibilitychange", handleVisibilityChange);
  // Explicit call instead of `watch(..., {immediate:true})`: the immediate callback fires
  // during setup(), before the template ref is assigned, so it would always no-op on `src`
  // values that are already non-empty at mount time (e.g. remounting this page while a
  // preview/recording is still running elsewhere) and the preview would stay blank forever.
  loadSource(props.src);
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", handleVisibilityChange);
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
  stopStallWatchdog();
  stopAudioStatsWatch();

  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (pc) {
    pc.close();
    pc = null;
  }

  if (webrtcSessionUrl) {
    fetch(webrtcSessionUrl, { method: "DELETE" }).catch(() => {});
    webrtcSessionUrl = null;
  }
}

// Reconnects only if `whepUrl` is still the src this player wants — guards against a
// stale watchdog/state-change callback firing after the src has already moved on.
function scheduleReconnect(whepUrl: string) {
  if (reconnectTimer !== null) return;

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (props.src !== whepUrl) return;
    teardownWebrtc();
    connectWebrtc(whepUrl);
  }, 1000);
}

// Live preview should never require a manual page refresh to recover: retries the WHEP
// handshake indefinitely (until the src changes or the component unmounts) instead of
// giving up after a fixed number of attempts, since MediaMTX/ffmpeg may still be starting up.
async function connectWebrtc(whepUrl: string) {
  const ac = new AbortController();
  abortController = ac;

  const connection = new RTCPeerConnection();
  pc = connection;

  connection.addTransceiver("video", { direction: "recvonly" });
  connection.addTransceiver("audio", { direction: "recvonly" });

  connection.ontrack = (event) => {
    if (video.value) {
      video.value.srcObject = event.streams[0];
    }
  };

  connection.onconnectionstatechange = () => {
    if (ac.signal.aborted) return;
    if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
      scheduleReconnect(whepUrl);
    }
  };

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);

  while (!ac.signal.aborted) {
    let response: Response | null = null;
    try {
      response = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: connection.localDescription!.sdp,
        signal: ac.signal,
      });
    } catch {
      // Aborted means the component unmounted or the src changed — stop retrying
      if (ac.signal.aborted) return;
      // Network error (connection refused, WHEP not ready yet) — keep retrying
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (response.ok) {
      const answerSdp = await response.text();
      const location = response.headers.get("Location");
      webrtcSessionUrl = location ? new URL(location, whepUrl).toString() : null;
      await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
      startStallWatchdog();
      startAudioStatsWatch(connection);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Polls WebRTC receive stats rather than trusting track/transceiver existence — a recvonly
// audio transceiver negotiates successfully even when the publisher never actually sends
// audio (true today, since nothing upstream embeds real audio yet), so "is there a track" is
// not a reliable signal. Compares packetsReceived between ticks so a connection that goes
// silent (publisher stops sending, even though the connection itself stays up) is reflected
// too, not just the very first packet ever seen.
function startAudioStatsWatch(connection: RTCPeerConnection) {
  stopAudioStatsWatch();
  lastAudioPacketsReceived = 0;

  audioStatsHandle = window.setInterval(async () => {
    const audioReceiver = connection.getReceivers().find((receiver) => receiver.track.kind === "audio");
    if (!audioReceiver) {
      audioDetected.value = false;
      return;
    }

    try {
      const stats = await audioReceiver.getStats();
      let packetsReceived = 0;
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          packetsReceived = report.packetsReceived ?? 0;
        }
      });
      audioDetected.value = packetsReceived > lastAudioPacketsReceived;
      lastAudioPacketsReceived = packetsReceived;
    } catch {
      audioDetected.value = false;
    }
  }, AUDIO_STATS_INTERVAL_MS);
}

function stopAudioStatsWatch() {
  if (audioStatsHandle !== null) {
    window.clearInterval(audioStatsHandle);
    audioStatsHandle = null;
  }
  audioDetected.value = false;
}

// Backstop for the case where the connection reports "connected" but no frames are
// actually flowing (e.g. the track stalls without ever changing connection state) —
// checks that the video element's playback position keeps advancing, and reconnects
// from scratch if it's been frozen for too long.
function startStallWatchdog() {
  stopStallWatchdog();
  lastFrameTime = video.value?.currentTime ?? -1;
  lastFrameProgressAt = Date.now();

  stallWatchdogHandle = window.setInterval(() => {
    if (!video.value) return;

    const currentTime = video.value.currentTime;
    if (currentTime !== lastFrameTime) {
      lastFrameTime = currentTime;
      lastFrameProgressAt = Date.now();
      return;
    }

    if (Date.now() - lastFrameProgressAt > STALL_TIMEOUT_MS) {
      const whepUrl = props.src;
      teardownWebrtc();
      if (whepUrl && whepUrl.includes("/whep")) {
        connectWebrtc(whepUrl);
      }
    }
  }, STALL_CHECK_INTERVAL_MS);
}

function stopStallWatchdog() {
  if (stallWatchdogHandle !== null) {
    window.clearInterval(stallWatchdogHandle);
    stallWatchdogHandle = null;
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
            <dd>{{ description || "Emerald recordings saved by the backend will preview here." }}</dd>
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
        <i></i> {{ transportLabel || (mode === "broadcast" ? "Broadcasting ..." : "Recording ...") }}
      </span>
      <span v-if="isCapture && hasPlayback" class="audio-indicator" :class="{ active: audioDetected }" :title="audioDetected ? 'Receiving audio' : 'No audio detected'">
        <i></i> {{ audioDetected ? "Audio" : "No Audio" }}
      </span>
      <button
        type="button"
        class="pause active"
        :class="{ play: showPlayIcon }"
        :disabled="isCapture ? (isBusy || isRecording) : !props.src"
        :aria-label="isCapture ? (mode === 'broadcast' ? 'Go live' : 'Start encoding') : (isPaused ? 'Play' : 'Pause')"
        @click="togglePlayback"
      ></button>
      <button
        type="button"
        class="stop"
        :disabled="isCapture && (isBusy || !isRecording)"
        :aria-label="mode === 'broadcast' ? 'Stop broadcast' : 'Stop encoding'"
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

    <div v-if="mode === 'library' && showPutOnAir" class="actions preview-actions">
      <button type="button" :disabled="!canPutOnAir" @click="emit('putOnAir')">
        Put on Air
      </button>
    </div>

    <dl v-if="isCapture" class="capture-meta">
      <div>
        <dt>Source URL</dt>
        <dd>{{ sourceUrl || "--" }}</dd>
      </div>
      <div>
        <dt>Title</dt>
        <dd>{{ title || "Emerald live preview" }}</dd>
      </div>
      <div>
        <dt>Description</dt>
        <dd>{{ description || "The right video frame shows the stream currently being published from Emerald." }}</dd>
      </div>
      <div>
        <dt>{{ mode === "broadcast" ? "Destination" : "Output path" }}</dt>
        <dd>{{ outputPath || "--" }}</dd>
      </div>
      <div>
        <dt>{{ mode === "broadcast" ? "Status" : "Duration" }}</dt>
        <dd>{{ durationLabel || detail || "--" }}</dd>
      </div>
      <div v-if="mode !== 'broadcast'">
        <dt>FPS</dt>
        <dd>{{ fpsLabel || "--" }}</dd>
      </div>
      <div>
        <dt>Format</dt>
        <dd>{{ formatLabel || (mode === "broadcast" ? "FLV | RTMP" : "MOV | ProRes 422") }}</dd>
      </div>
      <div v-if="mode !== 'broadcast'">
        <dt>Video Bitrate</dt>
        <dd>{{ videoBitrateLabel || "--" }}</dd>
      </div>
      <div>
        <dt>Audio Bitrate</dt>
        <dd>{{ audioBitrateLabel || "--" }}</dd>
      </div>
      <div v-if="mode !== 'broadcast'">
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
