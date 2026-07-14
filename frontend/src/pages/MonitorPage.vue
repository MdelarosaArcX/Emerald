<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useRecorderStore } from "../stores/recorder";
import { useTxStore } from "../stores/tx";

// Video-only confidence monitor meant to be opened on another machine on the same network — no
// editing chrome, no controls, just live video, auto-connecting and self-healing so it can be
// left open unattended on a monitor wall. Three routes share this one component:
//   /monitor          both feeds side by side
//   /monitor/capture   Capture live preview only, full screen
//   /monitor/onair      whatever's on air only, full screen
// Separate routes (not just a display toggle) so each can be opened on its own machine/browser
// tab independently, and so a capture-only tab never opens a WHEP connection it won't show, etc.
const route = useRoute();
const mode = computed(() => (route.meta.monitorMode as "capture" | "onair" | undefined) || "both");
const showCapture = computed(() => mode.value === "both" || mode.value === "capture");
const showOnAir = computed(() => mode.value === "both" || mode.value === "onair");

const recorder = useRecorderStore();
const tx = useTxStore();

const captureVideo = ref<HTMLVideoElement | null>(null);
const onAirVideo = ref<HTMLVideoElement | null>(null);
const captureConnected = ref(false);
const onAirConnected = ref(false);
let refreshHandle: number | null = null;

// --- Start time / timecode overlay: pulled from the same /api/capture/timecode endpoint the
// Playback page uses, so both monitor tiles can show "when did this actually start" alongside
// the live picture without needing their own tracking logic ---
type CaptureTimecodeResponse = {
  timecode: string;
  capture: { isCapturing: boolean; startedAt: string | null };
  onAir: { isTransmitting: boolean; startedAt: string | null; timecode: string; broadcastDelaySeconds: number };
};

const captureTimecode = ref<CaptureTimecodeResponse | null>(null);

function formatStartTime(iso: string | null): string {
  if (!iso) return "--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString([], { hour12: false });
}

const captureStartLabel = computed(() => formatStartTime(captureTimecode.value?.capture.startedAt ?? null));
const onAirStartLabel = computed(() => formatStartTime(captureTimecode.value?.onAir.startedAt ?? null));
// Deliberately NOT the same value as the capture tile — when a broadcast delay is set, whatever's
// on air right now was captured that many seconds ago, so its timecode should visibly trail
// capture's, not mirror it. See the /api/capture/timecode handler for how this is computed.
const liveTimecode = computed(() => captureTimecode.value?.timecode ?? "--:--:--:--");
const onAirTimecode = computed(() => captureTimecode.value?.onAir.timecode ?? "--:--:--:--");
const onAirBroadcastDelay = computed(() => captureTimecode.value?.onAir.broadcastDelaySeconds ?? 0);

async function refreshCaptureTimecode() {
  try {
    const response = await fetch("/api/capture/timecode");
    if (!response.ok) return;
    captureTimecode.value = await response.json();
  } catch {
    // Transient — the next poll will retry.
  }
}

// --- Capture preview: WebRTC/WHEP, same mechanism as the Capture page's own live preview ---
let capturePc: RTCPeerConnection | null = null;
let captureSessionUrl: string | null = null;
let captureAbort: AbortController | null = null;
let captureReconnectTimer: number | null = null;

function teardownCapture() {
  captureAbort?.abort();
  captureAbort = null;

  if (captureReconnectTimer !== null) {
    window.clearTimeout(captureReconnectTimer);
    captureReconnectTimer = null;
  }

  if (capturePc) {
    capturePc.close();
    capturePc = null;
  }

  if (captureSessionUrl) {
    fetch(captureSessionUrl, { method: "DELETE" }).catch(() => {});
    captureSessionUrl = null;
  }

  if (captureVideo.value) captureVideo.value.srcObject = null;
  captureConnected.value = false;
}

function scheduleCaptureReconnect(whepUrl: string) {
  if (captureReconnectTimer !== null) return;

  captureReconnectTimer = window.setTimeout(() => {
    captureReconnectTimer = null;
    if (recorder.activePreviewUrl !== whepUrl) return;
    teardownCapture();
    connectCapture(whepUrl);
  }, 1000);
}

async function connectCapture(whepUrl: string) {
  const ac = new AbortController();
  captureAbort = ac;

  const connection = new RTCPeerConnection();
  capturePc = connection;
  connection.addTransceiver("video", { direction: "recvonly" });

  connection.ontrack = (event) => {
    if (captureVideo.value) captureVideo.value.srcObject = event.streams[0];
  };

  connection.onconnectionstatechange = () => {
    if (ac.signal.aborted) return;
    if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
      scheduleCaptureReconnect(whepUrl);
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
      if (ac.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (response.ok) {
      const answerSdp = await response.text();
      const location = response.headers.get("Location");
      captureSessionUrl = location ? new URL(location, whepUrl).toString() : null;
      await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

watch(() => recorder.activePreviewUrl, (url) => {
  if (!showCapture.value) return;
  teardownCapture();
  if (url) connectCapture(url);
});

// --- On air: same low-latency WebRTC/WHEP feed as the Playback page's preview, sourced from
// RX5 (a physical SDI loopback of the actual TX6 output). Previously this tile played back the
// raw HLS segments TX writes to disk, which trails several seconds behind — swapped to WHEP so
// what a monitor-wall viewer sees actually matches what's really on air right now. ---
const onAirWhepUrl = ref("");
const showOnAirPreview = computed(() => tx.isTransmitting && Boolean(onAirWhepUrl.value));

let onAirPc: RTCPeerConnection | null = null;
let onAirSessionUrl: string | null = null;
let onAirAbort: AbortController | null = null;
let onAirReconnectTimer: number | null = null;

function teardownOnAir() {
  onAirAbort?.abort();
  onAirAbort = null;

  if (onAirReconnectTimer !== null) {
    window.clearTimeout(onAirReconnectTimer);
    onAirReconnectTimer = null;
  }

  if (onAirPc) {
    onAirPc.close();
    onAirPc = null;
  }

  if (onAirSessionUrl) {
    fetch(onAirSessionUrl, { method: "DELETE" }).catch(() => {});
    onAirSessionUrl = null;
  }

  if (onAirVideo.value) onAirVideo.value.srcObject = null;
  onAirConnected.value = false;
}

function scheduleOnAirReconnect(whepUrl: string) {
  if (onAirReconnectTimer !== null) return;

  onAirReconnectTimer = window.setTimeout(() => {
    onAirReconnectTimer = null;
    if (!showOnAirPreview.value || onAirWhepUrl.value !== whepUrl) return;
    teardownOnAir();
    connectOnAir(whepUrl);
  }, 1000);
}

async function connectOnAir(whepUrl: string) {
  const ac = new AbortController();
  onAirAbort = ac;

  const connection = new RTCPeerConnection();
  onAirPc = connection;
  connection.addTransceiver("video", { direction: "recvonly" });

  connection.ontrack = (event) => {
    if (onAirVideo.value) onAirVideo.value.srcObject = event.streams[0];
  };

  connection.onconnectionstatechange = () => {
    if (ac.signal.aborted) return;
    if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
      scheduleOnAirReconnect(whepUrl);
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
      if (ac.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (response.ok) {
      const answerSdp = await response.text();
      const location = response.headers.get("Location");
      onAirSessionUrl = location ? new URL(location, whepUrl).toString() : null;
      await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

watch(showOnAirPreview, (show) => {
  if (!showOnAir.value) return;
  teardownOnAir();
  if (show) connectOnAir(onAirWhepUrl.value);
});

function onCapturePlaying() {
  captureConnected.value = true;
}

function onOnAirPlaying() {
  onAirConnected.value = true;
}

onMounted(async () => {
  if (showOnAir.value) {
    try {
      const response = await fetch("/api/onair-preview/status");
      if (response.ok) {
        const data = await response.json();
        onAirWhepUrl.value = data.whepUrl || "";
      }
    } catch {
      // Left empty — the on-air tile just shows "Nothing is on air" until this can be retried.
    }
  }

  await Promise.all([recorder.refresh(), tx.refresh(), refreshCaptureTimecode()]);
  if (showCapture.value && recorder.activePreviewUrl) connectCapture(recorder.activePreviewUrl);
  if (showOnAir.value && showOnAirPreview.value) connectOnAir(onAirWhepUrl.value);

  refreshHandle = window.setInterval(async () => {
    await Promise.all([recorder.refresh(), tx.refresh(), refreshCaptureTimecode()]);
  }, 1000);
});

onBeforeUnmount(() => {
  if (refreshHandle !== null) window.clearInterval(refreshHandle);
  if (showCapture.value) teardownCapture();
  if (showOnAir.value) teardownOnAir();
});
</script>

<template>
  <div class="monitor-wall" :class="{ single: mode !== 'both' }">
    <section v-if="showCapture" class="monitor-tile">
      <div class="monitor-label">
        <div class="monitor-label-row">
          CAPTURE
          <span v-if="recorder.isRecording" class="dot live"></span>
        </div>
        <div v-if="captureTimecode?.capture.isCapturing" class="monitor-label-meta">
          Started {{ captureStartLabel }} &middot; {{ liveTimecode }}
        </div>
      </div>
      <video ref="captureVideo" autoplay muted playsinline @playing="onCapturePlaying"></video>
      <div v-if="!captureConnected" class="monitor-empty">
        {{ recorder.webrtcStatus?.isRunning ? "Connecting..." : "Capture preview is not running" }}
      </div>
    </section>

    <section v-if="showOnAir" class="monitor-tile">
      <div class="monitor-label">
        <div class="monitor-label-row">
          ON AIR{{ tx.status ? ` (TX${tx.status.channelIndex})` : "" }}
          <span v-if="tx.isTransmitting" class="dot live" :class="{ stalled: tx.isStalled }"></span>
        </div>
        <div v-if="captureTimecode?.onAir.isTransmitting" class="monitor-label-meta">
          Started {{ onAirStartLabel }} &middot; {{ onAirTimecode }}
          <template v-if="onAirBroadcastDelay > 0"> &middot; -{{ onAirBroadcastDelay }}s delay</template>
        </div>
      </div>
      <video ref="onAirVideo" autoplay muted playsinline @playing="onOnAirPlaying"></video>
      <div v-if="!onAirConnected" class="monitor-empty">
        {{
          !tx.isTransmitting
            ? "Nothing is on air"
            : !onAirWhepUrl
              ? "On-air preview isn't running"
              : "Connecting..."
        }}
      </div>
    </section>
  </div>
</template>

<style scoped>
.monitor-wall {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  width: 100vw;
  height: 100vh;
  background: #000;
}

.monitor-wall.single {
  grid-template-columns: 1fr;
}

@media (max-width: 900px) {
  .monitor-wall:not(.single) {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
}

.monitor-tile {
  position: relative;
  background: #000;
  overflow: hidden;
}

.monitor-tile video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.monitor-label {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2;
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font: 600 13px/1.4 system-ui, sans-serif;
  letter-spacing: 0.06em;
  border-radius: 4px;
}

.monitor-label-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.monitor-label-meta {
  margin-top: 2px;
  font: 500 11px/1.4 system-ui, sans-serif;
  letter-spacing: 0.02em;
  color: #ccc;
  font-variant-numeric: tabular-nums;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e33;
  box-shadow: 0 0 6px #e33;
}

.dot.stalled {
  background: #e6a700;
  box-shadow: 0 0 6px #e6a700;
}

.monitor-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #888;
  font: 500 15px system-ui, sans-serif;
  text-align: center;
  padding: 24px;
}
</style>
