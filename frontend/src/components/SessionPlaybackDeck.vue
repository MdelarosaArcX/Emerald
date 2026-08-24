<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from "vue";
import { useSessionPlaybackStore } from "../stores/sessionPlayback";
import { useTxStore } from "../stores/tx";
import { useMonitorAudio } from "../composables/useMonitorAudio";
import { useDeltacastHardwareStore } from "../stores/deltacastHardware";

const sessionPlayback = useSessionPlaybackStore();
const hardware = useDeltacastHardwareStore();

/**
 * Which SDI output transmits. Staged rather than applied: DeltacastCaptureService binds the TX
 * channel when it opens the stream and there is no runtime switch, so selecting here records the
 * intent and the panel says a restart is needed instead of implying it took effect.
 */
const stagedTxBoard = ref<number | null>(null);
const stagedTxChannel = ref<number | null>(null);

const txBoard = computed({
  get: () => stagedTxBoard.value ?? hardware.inUse?.transmit.boardIndex ?? 0,
  set: (value: number) => {
    stagedTxBoard.value = Number(value);
    // A channel index is only meaningful against its board — carrying the old one over would point
    // at a different physical connector.
    stagedTxChannel.value = hardware.txChannels(Number(value))[0]?.channelIndex ?? 0;
  },
});

const txChannel = computed({
  get: () => stagedTxChannel.value ?? hardware.inUse?.transmit.channelIndex ?? 0,
  set: (value: number) => { stagedTxChannel.value = Number(value); },
});

const txSelectionChanged = computed(() =>
  hardware.inUse !== null
  && (txBoard.value !== hardware.inUse.transmit.boardIndex
    || txChannel.value !== hardware.inUse.transmit.channelIndex),
);
const tx = useTxStore();
const video = ref<HTMLVideoElement | null>(null);

// This deck monitors the on-air feed. The element stays muted in markup so it can autoplay;
// audio is enabled on the element's property only once the operator clicks the speaker.
const monitorAudio = useMonitorAudio("playback-deck");
const audible = computed(() => monitorAudio.enabled.value && monitorAudio.isOwner.value);
watch([audible, monitorAudio.volume, video], () => monitorAudio.apply(video.value));
const isPlaying = ref(false);
const now = ref(Date.now());
const refreshHandle = ref<number | null>(null);
const clockHandle = ref<number | null>(null);

let pc: RTCPeerConnection | null = null;
let webrtcSessionUrl: string | null = null;
let abortController: AbortController | null = null;
let reconnectTimer: number | null = null;
let stallWatchdogHandle: number | null = null;
let lastFrameTime = -1;
let lastFrameProgressAt = 0;

const STALL_TIMEOUT_MS = 8000;
const STALL_CHECK_INTERVAL_MS = 2000;
// This preview is sourced from RX5 — a physical SDI loopback of the actual TX6 output — so unlike
// the earlier approach (mirroring TX's own decode pipeline in software), it's the real physical
// signal, the same way Capture's own preview is a real physical RX3 input. There can still be a
// small residual gap against something like dCARE (this preview's own WebRTC encode/transport
// path vs. dCARE's own SDI decode path aren't identical), so this stays operator-tunable rather
// than assumed to be exactly zero — dial it in while watching dCARE side by side with this
// preview until they visually match. Persisted so it doesn't need re-tuning every session.
const WEBRTC_DELAY_STORAGE_KEY = "emerald.sessionPlayback.webrtcDelaySeconds";
const WEBRTC_DELAY_DEFAULT_SECONDS = 0;
// Storage lookup deliberately checks for null rather than falling back with `||` — a previously
// saved "0" (delay intentionally turned off) is falsy and `|| 2` would silently override it back
// to the default every time the page loads, which defeats the point of persisting it at all.
const storedWebrtcDelay = localStorage.getItem(WEBRTC_DELAY_STORAGE_KEY);
const webrtcDelaySeconds = ref(storedWebrtcDelay !== null ? Number(storedWebrtcDelay) : WEBRTC_DELAY_DEFAULT_SECONDS);
let currentReceiver: (RTCRtpReceiver & { playoutDelayHint?: number }) | null = null;

watch(webrtcDelaySeconds, (value) => {
  localStorage.setItem(WEBRTC_DELAY_STORAGE_KEY, String(value));
  // Applies live to whatever's already connected — no need to reconnect just to retune.
  if (currentReceiver) currentReceiver.playoutDelayHint = value;
});

// Static for the lifetime of the backend process (only changes if MEDIAMTX_PUBLIC_HOST is
// reconfigured, which needs a backend restart anyway) — fetched once on mount instead of polled.
const onAirWhepUrl = ref("");

const selectedSession = computed(() => sessionPlayback.sessions.find((session) => session.folder === sessionPlayback.selectedFolder));
const txChannelLabel = computed(() => (tx.status ? `TX${tx.status.channelIndex}` : "TX"));
// RX5's own capture pipeline (OnAirPreviewWorker, always running once DeltacastCaptureService is
// up — same as RX3/Capture) publishes directly to MediaMTX, so there's nothing to "start" from
// here beyond connecting. Gated on tx.isTransmitting anyway, purely for UX: RX5 only ever shows
// something meaningful while TX6 actually has a signal on it, so there's no point connecting (and
// showing a black/no-signal frame) just because a folder got picked in the dropdown.
const showPreview = computed(() => tx.isTransmitting && Boolean(onAirWhepUrl.value));
// How far what's actually on air trails "now" — 0 unless TX is playing the current session's
// broadcast-delayed live feed (see /api/capture/timecode's onAir.broadcastDelaySeconds). Polled
// alongside the other 5s status refreshes below and applied locally so the on-screen clock can
// still tick smoothly every 40ms without a network round-trip per frame.
//
// That figure is now *measured* — the backend derives it from TX's frame counter against the
// playlist rather than assuming the configured delay (see server.js's onAirContentTime). It
// therefore stays correct when TX starts at the first segment rather than near the live edge, and
// it is the same position LiveEdit's timeline draws its on-air marker at, so the two agree.
// Subtracting it from `now` here is still right: air and the clock both advance at 1x, so a value
// polled every few seconds stays accurate between polls.
const onAirBroadcastDelaySeconds = ref(0);
// Picked up from the same poll: how far this browser's clock sits from the backend's
// generator-corrected one, and the frame rate the generator counts in. Same split as the Capture
// page — the local ticker gives a smooth 40ms readout, these two make what it shows the
// generator's timecode rather than this machine's idea of the time.
const clockOffsetMs = ref(0);
const generatorFps = ref(25);
const timecode = computed(() =>
  toWallClockTimecode(now.value + clockOffsetMs.value - onAirBroadcastDelaySeconds.value * 1000),
);

// --- Tidal Lock readiness countdown -------------------------------------------------------------
// A new recording has nothing airable until a segment has finished writing AND aged past the
// broadcast delay (see sessionPlayback.onAirReadyAtMs). That is a three-minute wait at the
// recorder's defaults, during which Tidal Lock looks like it is doing nothing — so it says how long
// it has left instead. Driven off the same `now` ticker as the on-screen clock.
const onAirHoldRemainingMs = computed(() => {
  const readyAtMs = sessionPlayback.onAirReadyAtMs;
  if (readyAtMs === null) return 0;
  return Math.max(0, readyAtMs - (now.value + clockOffsetMs.value));
});

/** Only a countdown while it is actually holding something back — not once air is already up. */
const showOnAirCountdown = computed(() => onAirHoldRemainingMs.value > 0 && !tx.isTransmitting);

const onAirCountdown = computed(() => {
  const totalSeconds = Math.ceil(onAirHoldRemainingMs.value / 1000);
  return `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
});

/** Progress through the hold, 0..1 — drives the countdown bar. */
const onAirCountdownProgress = computed(() => {
  const totalMs = sessionPlayback.onAirHoldSeconds * 1000;
  if (totalMs <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - onAirHoldRemainingMs.value / totalMs));
});

/** Which of the two stacked waits is still running, so the countdown says what it is waiting for. */
const onAirCountdownStage = computed(() => {
  const recorder = sessionPlayback.recorder;
  if (!recorder) return "";
  const delayMs = (recorder.broadcastDelaySeconds ?? 0) * 1000;
  return onAirHoldRemainingMs.value > delayMs
    ? "Waiting for the first segment to finish recording"
    : "Segment recorded — serving the broadcast delay";
});

async function refreshOnAirDelay() {
  try {
    const sentAt = Date.now();
    const response = await fetch("/api/capture/timecode");
    if (!response.ok) return;
    const data = await response.json();
    const receivedAt = Date.now();

    onAirBroadcastDelaySeconds.value = data?.onAir?.broadcastDelaySeconds ?? 0;
    generatorFps.value = data?.timecodeSource?.frameRate || data?.fps || 25;

    // Assume the backend read its clock at the midpoint of this request.
    const backendNow = Date.parse(data?.timestamp);
    if (Number.isFinite(backendNow)) {
      clockOffsetMs.value = backendNow - (sentAt + (receivedAt - sentAt) / 2);
      // The Tidal Lock hold is measured against the recorder's backend-stamped start time, so it
      // needs the same correction this clock already applies — shared rather than measured twice.
      sessionPlayback.setClockOffsetMs(clockOffsetMs.value);
    }
  } catch {
    // Transient — the next 5s poll will retry; the clock just keeps using the last known delay.
  }
}

watch(showPreview, (show) => {
  teardownWebrtc();
  if (show) connectWebrtc(onAirWhepUrl.value);
});

// A staged clip is a single slot ("Put on Air" in the Media Browser replaces whatever was
// there before), and TX plays it once and stops — once transmission ends, clear the stage
// instead of leaving a "Push On Air" button pointing at a clip that's no longer airing.
watch(() => tx.isTransmitting, (isTransmitting, wasTransmitting) => {
  if (wasTransmitting && !isTransmitting && sessionPlayback.cuedClip) {
    sessionPlayback.clearCue();
  }
});

// TX7/TX5 is a hardware SDI output an operator can easily forget is still live once they've
// switched to another browser tab — surface on-air state in the tab title too, not just the
// on-page badges, so it's visible without switching back.
let originalTitle = "";

watch([() => tx.isTransmitting, () => tx.isStalled], ([isTransmitting, isStalled]) => {
  if (!originalTitle) originalTitle = document.title;
  document.title = isTransmitting
    ? `${isStalled ? "⚠ STALLED" : "🔴 ON AIR"} — ${originalTitle}`
    : originalTitle;
});

onMounted(async () => {
  try {
    const response = await fetch("/api/onair-preview/status");
    const result = await response.json();
    if (response.ok) onAirWhepUrl.value = result.whepUrl;
  } catch {
    // Optional infrastructure (DeltacastCaptureService may not be running) — no on-air preview
    // available, but the rest of the page (folder selection, Push On Air, Tidal Lock) still works.
  }

  await Promise.all([sessionPlayback.loadSessions(), sessionPlayback.loadRecorderStatus(), tx.refresh(), refreshOnAirDelay(), hardware.fetch()]);
  // Explicit call instead of relying on the watch() above: showPreview can already be true the
  // moment this component mounts (e.g. Tidal Lock re-engaging after navigating back to this
  // page) — a plain watch() only fires on a *change*, so without this the preview would stay
  // blank until TX was toggled off and back on.
  if (showPreview.value) connectWebrtc(onAirWhepUrl.value);
  // Tidal Lock's enabled flag persists across refreshes/page navigation (see sessionPlayback
  // store) — re-sync immediately on mount instead of waiting up to 5s for the next poll tick.
  await sessionPlayback.applyTidalLock();
  refreshHandle.value = window.setInterval(async () => {
    await Promise.all([sessionPlayback.loadSessions(), sessionPlayback.loadRecorderStatus(), tx.refresh(), refreshOnAirDelay()]);
    await sessionPlayback.applyTidalLock();
  }, 5000);
  clockHandle.value = window.setInterval(() => {
    now.value = Date.now();
  }, 40);
});

onUnmounted(() => {
  if (refreshHandle.value) {
    window.clearInterval(refreshHandle.value);
  }
  if (clockHandle.value) {
    window.clearInterval(clockHandle.value);
  }
});

function toggleOnAir() {
  if (tx.isTransmitting) {
    tx.stop();
  } else if (sessionPlayback.selectedFolder) {
    tx.start(sessionPlayback.selectedFolder);
  }
}

function pushCuedClipOnAir() {
  if (!sessionPlayback.cuedClip || tx.isTransmitting) return;
  tx.start(sessionPlayback.cuedClip.folder, sessionPlayback.cuedClip.fileName);
}

onBeforeUnmount(() => {
  teardownWebrtc();
  if (originalTitle) document.title = originalTitle;
});

// Just stages the pick for Push On Air / Tidal Lock — does not by itself connect the preview
// (showPreview only becomes true once TX is actually transmitting).
function onFolderChange(event: Event) {
  const folder = (event.target as HTMLSelectElement).value;
  sessionPlayback.selectFolder(folder);
}

function teardownWebrtc() {
  abortController?.abort();
  abortController = null;
  currentReceiver = null;
  stopStallWatchdog();

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

  if (video.value) {
    video.value.srcObject = null;
  }

  isPlaying.value = false;
}

// Reconnects only if `showPreview` still wants this exact URL — guards against a stale
// watchdog/state-change callback firing after on-air state has already moved on.
function scheduleReconnect(whepUrl: string) {
  if (reconnectTimer !== null) return;

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!showPreview.value || onAirWhepUrl.value !== whepUrl) return;
    teardownWebrtc();
    connectWebrtc(whepUrl);
  }, 1000);
}

// Retries the WHEP handshake indefinitely (until on-air state changes or the component unmounts)
// instead of giving up after a fixed number of attempts — RX5's signal lock and MediaMTX startup
// can both take a moment, and TX itself may take a beat to actually start outputting after going
// on air.
async function connectWebrtc(whepUrl: string) {
  const ac = new AbortController();
  abortController = ac;

  const connection = new RTCPeerConnection();
  pc = connection;

  connection.addTransceiver("video", { direction: "recvonly" });

  connection.ontrack = (event) => {
    if (video.value) {
      video.value.srcObject = event.streams[0];
      video.value.play().catch(() => {});
    }

    // playoutDelayHint (Chromium) asks the receive-side jitter buffer to target this much
    // end-to-end delay instead of the minimum it'd otherwise aim for — the supported way to
    // deliberately add latency to a *live* WebRTC track without hand-rolling a frame buffer via
    // WebCodecs. Not in the standard TS DOM types yet, hence the cast.
    const receiver = event.receiver as RTCRtpReceiver & { playoutDelayHint?: number };
    if (receiver && "playoutDelayHint" in receiver) {
      receiver.playoutDelayHint = webrtcDelaySeconds.value;
      currentReceiver = receiver;
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
      if (ac.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (response.ok) {
      const answerSdp = await response.text();
      const location = response.headers.get("Location");
      webrtcSessionUrl = location ? new URL(location, whepUrl).toString() : null;
      await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
      startStallWatchdog();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Backstop for the case where the connection reports "connected" but no frames are actually
// flowing — checks that the video element's playback position keeps advancing, and reconnects
// from scratch if it's been frozen too long.
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
      const whepUrl = onAirWhepUrl.value;
      teardownWebrtc();
      if (showPreview.value) connectWebrtc(whepUrl);
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
  isPlaying.value = true;
  // A reconnect swaps in a new MediaStream, which arrives muted — reassert the operator's choice.
  monitorAudio.apply(video.value);
}

function onPause() {
  isPlaying.value = false;
}

function onVideoError() {
  isPlaying.value = false;
}

function toWallClockTimecode(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "00:00:00:00";

  const frames = Math.floor((date.getMilliseconds() / 1000) * generatorFps.value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(frames)}`;
}

function pad(value: number) {
  return String(Math.trunc(value)).padStart(2, "0");
}

function useFallbackStill(event: Event) {
  (event.target as HTMLImageElement).style.visibility = "hidden";
}

function formatSize(size?: number) {
  if (!size) return "--";
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString();
}

function formatLastFrame(value?: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const secondsAgo = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  return secondsAgo <= 1 ? "just now" : `${secondsAgo}s ago`;
}
</script>

<template>
  <section class="preview-panel capture">
    <div class="timecode">{{ timecode }}</div>
    <div class="video-frame">
      <video
        ref="video"
        autoplay
        muted
        playsinline
        @playing="onPlaying"
        @pause="onPause"
        @error="onVideoError"
      ></video>
      <div v-if="!showPreview" class="source-prompt" aria-live="polite">
        <span class="source-prompt-icon" aria-hidden="true"></span>
        <span>{{ sessionPlayback.selectedFolder ? "Push On Air or engage Tidal Lock to preview" : "Select a recording folder to begin" }}</span>
      </div>
      <div v-else-if="!isPlaying" class="source-prompt" aria-live="polite">
        <span>Connecting...</span>
      </div>
      <div
        v-if="tx.isTransmitting"
        class="tally-light"
        :class="{ stalled: tx.isStalled }"
        role="status"
      >
        {{ txChannelLabel }} ON AIR{{ tx.isStalled ? " — STALLED" : "" }}
      </div>
    </div>

    <div class="transport recording">
      <span v-if="isPlaying" class="record-label">
        <i></i> On-air preview (WebRTC)
      </span>
      <button
        type="button"
        class="monitor-audio"
        :class="{ on: audible }"
        :disabled="!isPlaying"
        :aria-pressed="audible"
        :title="audible
          ? `Monitoring on-air audio (${Math.round(monitorAudio.volume.value * 100)}%) — click to mute`
          : 'Listen to the on-air feed'"
        @click="monitorAudio.toggle()"
      >{{ audible ? "🔊" : "🔇" }}</button>
      <input
        v-if="audible"
        v-model.number="monitorAudio.volume.value"
        class="monitor-volume"
        type="range"
        min="0"
        max="1"
        step="0.05"
        aria-label="Monitor volume"
        :title="`Monitor volume ${Math.round(monitorAudio.volume.value * 100)}%`"
      />
      <button type="button" class="fullscreen" aria-label="Fullscreen"></button>
    </div>

    <dl class="capture-meta">
      <div>
        <dt>Folder</dt>
        <dd>{{ sessionPlayback.selectedFolder || "--" }}</dd>
      </div>
      <div>
        <dt>Format</dt>
        <dd>WebRTC | H.264 (live, same feed as RX5)</dd>
      </div>
    </dl>
  </section>

  <aside class="recording-card">
    <header class="recording-header">
      <span class="radio-dot" :class="{ live: isPlaying }"></span>
      <h2>Playback</h2>
      <span
        v-if="tx.isTransmitting"
        class="on-air-badge"
        :class="{ stalled: tx.isStalled }"
        role="status"
      >
        {{ txChannelLabel }} ON AIR{{ tx.isStalled ? " — STALLED" : "" }}
      </span>
    </header>

    <div class="config-grid">
      <label class="field-row field-wide">
        <span>Recording Folder</span>
        <select
          class="compact-select"
          :value="sessionPlayback.selectedFolder"
          :disabled="tx.isTransmitting || sessionPlayback.tidalLockEnabled"
          :title="sessionPlayback.tidalLockEnabled ? 'Disengage Tidal Lock to pick a folder manually' : (tx.isTransmitting ? 'Take off air before switching folders' : '')"
          @change="onFolderChange"
        >
          <option value="" disabled>Select a folder...</option>
          <option v-for="session in sessionPlayback.sessions" :key="session.folder" :value="session.folder">
            {{ session.folder }}{{ session.isActive ? " (recording)" : "" }}
          </option>
        </select>
      </label>

      <!-- SDI output selection. Enumerated from the hardware, so only outputs that physically
           exist are offered — a 2-output card never lists eight. -->
      <label class="field-row field-wide" title="Which DELTACAST board carries the SDI output.">
        <span>Transmit Board</span>
        <select
          v-model.number="txBoard"
          class="compact-select auto-select"
          :disabled="!hardware.inventoryAvailable"
        >
          <option v-for="board in hardware.txBoards" :key="board.boardIndex" :value="board.boardIndex">
            {{ board.label }} — {{ board.txChannelCount }} TX
          </option>
          <option v-if="!hardware.txBoards.length" :value="txBoard">
            {{ hardware.loading ? "Reading hardware…" : "No SDI boards detected" }}
          </option>
        </select>
      </label>

      <label class="field-row field-wide" title="Which SDI output to transmit from.">
        <span>Transmit Channel</span>
        <select
          v-model.number="txChannel"
          class="compact-select auto-select"
          :disabled="!hardware.inventoryAvailable"
        >
          <option
            v-for="channel in hardware.txChannels(txBoard)"
            :key="channel.channelIndex"
            :value="channel.channelIndex"
          >
            {{ hardware.channelLabel(txBoard, channel.channelIndex, "tx") }}
          </option>
          <option v-if="!hardware.txChannels(txBoard).length" :value="txChannel">
            No SDI outputs on this board
          </option>
        </select>
      </label>

      <p v-if="txSelectionChanged" class="hardware-note">
        Output staged — DeltacastCaptureService binds the TX channel at startup, so restart it to
        transmit from TX{{ txChannel }} on board {{ txBoard }}.
      </p>
    </div>

    <div class="actions">
      <button
        type="button"
        :class="{ secondary: tx.isTransmitting }"
        :disabled="sessionPlayback.tidalLockEnabled || tx.isBusy || (!tx.isTransmitting && !selectedSession?.isActive)"
        :title="sessionPlayback.tidalLockEnabled ? 'Disengage Tidal Lock to control on-air state manually' : (!selectedSession?.isActive ? 'Stage a clip in the Media Browser and use Push On Air in the On Air Queue below' : '')"
        @click="toggleOnAir"
      >
        {{ tx.isTransmitting ? "Take Off Air" : "Push On Air (Live)" }}
      </button>
      <button
        type="button"
        class="tidal-lock"
        :class="{ active: sessionPlayback.tidalLockEnabled }"
        :aria-pressed="sessionPlayback.tidalLockEnabled"
        :title="sessionPlayback.tidalLockEnabled ? 'Disengage Tidal Lock' : 'Engage Tidal Lock — automatically follow and push the active recording live'"
        @click="sessionPlayback.toggleTidalLock"
      >
        {{ sessionPlayback.tidalLockEnabled ? "Tidal Lock: On" : "Tidal Lock" }}
      </button>
    </div>
    <p v-if="sessionPlayback.tidalLockEnabled" class="tidal-lock-status">
      {{
        !selectedSession?.isActive
          ? "Waiting for a recording to start..."
          : tx.isTransmitting
            ? `Following ${sessionPlayback.selectedFolder} — auto on air`
            : `Following ${sessionPlayback.selectedFolder} — holding until the first segment is airable`
      }}
    </p>

    <!-- The three-minute hold, made visible: an operator watching a fresh recording otherwise has
         no way to tell "Tidal Lock is waiting on purpose" from "Tidal Lock is broken". -->
    <div v-if="showOnAirCountdown" class="onair-countdown" role="status" aria-live="polite">
      <div class="onair-countdown-head">
        <span class="onair-countdown-label">On air in</span>
        <span class="onair-countdown-value">{{ onAirCountdown }}</span>
      </div>
      <div class="onair-countdown-bar">
        <span :style="{ width: `${onAirCountdownProgress * 100}%` }"></span>
      </div>
      <p class="onair-countdown-stage">{{ onAirCountdownStage }}</p>
      <p class="onair-countdown-detail">
        {{ sessionPlayback.recorder?.segmentSeconds ?? 0 }}s segment + {{ sessionPlayback.recorder?.broadcastDelaySeconds ?? 0 }}s broadcast delay
      </p>
    </div>

    <div class="onair-cue" v-if="sessionPlayback.cuedClip">
      <h3>On Air Queue</h3>
      <div class="cue-clip">
        <img :src="sessionPlayback.cuedClip.thumbnailUrl" :alt="sessionPlayback.cuedClip.fileName" @error="useFallbackStill" />
        <span>{{ sessionPlayback.cuedClip.fileName }}</span>
      </div>
      <div class="actions">
        <button type="button" :disabled="tx.isBusy || tx.isTransmitting" @click="pushCuedClipOnAir">
          Push On Air
        </button>
        <button type="button" class="secondary" :disabled="tx.isBusy" @click="sessionPlayback.clearCue()">
          Remove
        </button>
      </div>
    </div>

    <dl class="stats">
      <div>
        <dt>Segments</dt>
        <dd>{{ selectedSession?.segmentCount || "--" }}</dd>
      </div>
      <div>
        <dt>Size</dt>
        <dd>{{ formatSize(selectedSession?.size) }}</dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd>{{ formatDate(selectedSession?.createdAt) }}</dd>
      </div>
      <div>
        <dt>On Air</dt>
        <dd>
          {{ tx.isTransmitting ? (tx.isStalled ? `${txChannelLabel} stalled` : `${txChannelLabel} live`) : `Off air (${txChannelLabel})` }}
        </dd>
      </div>
      <div v-if="tx.isTransmitting">
        <dt>TX Frames</dt>
        <dd>{{ tx.status?.framesSent ?? 0 }} sent, {{ tx.status?.framesDropped ?? 0 }} dropped</dd>
      </div>
      <div v-if="tx.isTransmitting">
        <dt>Last TX Frame</dt>
        <dd>{{ formatLastFrame(tx.status?.lastFrameAt) }}</dd>
      </div>
      <div title="Compensates for the physical TX6 output's own buffering/processing latency, which this WebRTC preview doesn't otherwise share. Tune while comparing against TX6's actual output (e.g. dCARE via a real SDI loopback) until they visually match.">
        <dt>WebRTC Delay</dt>
        <dd>
          <input
            v-model.number="webrtcDelaySeconds"
            type="number"
            min="0"
            max="10"
            step="0.1"
            class="compact-input"
            style="width: 5em"
          />
          s
        </dd>
      </div>
      <div>
        <dt>Message</dt>
        <dd>{{ tx.message || sessionPlayback.message || "--" }}</dd>
      </div>
    </dl>
  </aside>
</template>
