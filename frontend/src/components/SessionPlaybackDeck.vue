<script setup lang="ts">
import Hls from "hls.js";
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from "vue";
import { useSessionPlaybackStore } from "../stores/sessionPlayback";
import { useTxStore } from "../stores/tx";

const sessionPlayback = useSessionPlaybackStore();
const tx = useTxStore();
const video = ref<HTMLVideoElement | null>(null);
const isPlaying = ref(false);
const internalTimecode = ref("00:00:00:00");
const streamMessage = ref("");
const refreshHandle = ref<number | null>(null);
let rafId: number | null = null;
let hls: Hls | null = null;
let streamFailed = false;

const selectedSession = computed(() => sessionPlayback.sessions.find((session) => session.folder === sessionPlayback.selectedFolder));
const txChannelLabel = computed(() => (tx.status ? `TX${tx.status.channelIndex}` : "TX"));
const playlistUrl = computed(() => (
  sessionPlayback.selectedFolder ? `/recordings/${encodeURIComponent(sessionPlayback.selectedFolder)}/emerald-tx-live.m3u8` : ""
));

watch(playlistUrl, (url) => {
  attachStream(url);
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
  await Promise.all([sessionPlayback.loadSessions(), tx.refresh()]);
  refreshHandle.value = window.setInterval(() => {
    sessionPlayback.loadSessions();
    tx.refresh();
    // The TX HLS rendition may not exist yet the instant a recording starts (first segment
    // still in progress) — retry attaching on the same interval instead of a separate timer.
    if (streamFailed) attachStream(playlistUrl.value);
  }, 5000);
});

onUnmounted(() => {
  if (refreshHandle.value) {
    window.clearInterval(refreshHandle.value);
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
  destroyStream();
  stopTimecodeLoop();
  if (originalTitle) document.title = originalTitle;
});

function onFolderChange(event: Event) {
  const folder = (event.target as HTMLSelectElement).value;
  sessionPlayback.selectFolder(folder);
}

// Plays the session's continuously-growing HLS rendition (emerald-tx.m3u8 + .ts segments,
// written by the recorder alongside the archival/playout files) instead of stepping through
// individual 5-minute segment files one at a time.
function attachStream(url: string) {
  destroyStream();
  streamMessage.value = "";
  streamFailed = false;

  if (!video.value || !url) return;

  if (Hls.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      streamFailed = true;
      streamMessage.value = data.details === "manifestLoadError"
        ? "Waiting for the first segment to finish recording..."
        : `HLS playback error: ${data.details}`;
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.value?.play().catch(() => {});
    });
    hls.loadSource(url);
    hls.attachMedia(video.value);
  } else if (video.value.canPlayType("application/vnd.apple.mpegurl")) {
    video.value.src = url;
    video.value.play().catch(() => {});
  } else {
    streamMessage.value = "This browser can't play HLS streams.";
  }
}

function destroyStream() {
  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (video.value) {
    video.value.removeAttribute("src");
    video.value.load();
  }
}

function togglePlayback() {
  if (!video.value || !playlistUrl.value) return;

  if (video.value.paused) {
    video.value.play().catch(() => {});
  } else {
    video.value.pause();
  }
}

function stopPlayback() {
  if (video.value) {
    video.value.pause();
    video.value.currentTime = 0;
  }

  isPlaying.value = false;
  stopTimecodeLoop();
}

function onPlaying() {
  isPlaying.value = true;
  startTimecodeLoop();
}

function onPause() {
  isPlaying.value = false;
  stopTimecodeLoop();
}

function onEnded() {
  isPlaying.value = false;
  stopTimecodeLoop();
}

function onVideoError() {
  isPlaying.value = false;
  stopTimecodeLoop();
}

function startTimecodeLoop() {
  if (rafId !== null) return;

  const tick = () => {
    if (video.value && selectedSession.value) {
      const startedMs = new Date(selectedSession.value.createdAt).getTime();
      internalTimecode.value = toWallClockTimecode(startedMs + video.value.currentTime * 1000);
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

function toWallClockTimecode(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "00:00:00:00";

  const frames = Math.floor((date.getMilliseconds() / 1000) * 25);
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
    <div class="timecode">{{ sessionPlayback.selectedFolder ? internalTimecode : "00:00:00:00" }}</div>
    <div class="video-frame">
      <video
        ref="video"
        muted
        playsinline
        @playing="onPlaying"
        @pause="onPause"
        @ended="onEnded"
        @error="onVideoError"
      ></video>
      <button
        v-if="!sessionPlayback.selectedFolder"
        type="button"
        class="source-prompt"
        aria-label="Select a recording folder"
      >
        <span class="source-prompt-icon" aria-hidden="true"></span>
        <span>Select a recording folder to begin playback</span>
      </button>
      <div v-else-if="streamMessage" class="source-prompt" aria-live="polite">
        <span>{{ streamMessage }}</span>
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
        <i></i> Playing continuously
      </span>
      <button
        type="button"
        class="pause active"
        :class="{ play: !isPlaying }"
        :disabled="!sessionPlayback.selectedFolder"
        aria-label="Play or pause"
        @click="togglePlayback"
      ></button>
      <button
        type="button"
        class="stop"
        :disabled="!sessionPlayback.selectedFolder"
        aria-label="Stop"
        @click="stopPlayback"
      ></button>
      <button type="button" class="fullscreen" aria-label="Fullscreen"></button>
    </div>

    <dl class="capture-meta">
      <div>
        <dt>Folder</dt>
        <dd>{{ sessionPlayback.selectedFolder || "--" }}</dd>
      </div>
      <div>
        <dt>Format</dt>
        <dd>HLS | H.264 (continuous)</dd>
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
          :disabled="tx.isTransmitting"
          :title="tx.isTransmitting ? 'Take off air before switching folders' : ''"
          @change="onFolderChange"
        >
          <option value="" disabled>Select a folder...</option>
          <option v-for="session in sessionPlayback.sessions" :key="session.folder" :value="session.folder">
            {{ session.folder }}{{ session.isActive ? " (recording)" : "" }}
          </option>
        </select>
      </label>
    </div>

    <div class="actions">
      <button
        type="button"
        :class="{ secondary: tx.isTransmitting }"
        :disabled="tx.isBusy || (!tx.isTransmitting && !selectedSession?.isActive)"
        :title="!selectedSession?.isActive ? 'Stage a clip in the Media Browser and use Push On Air in the On Air Queue below' : ''"
        @click="toggleOnAir"
      >
        {{ tx.isTransmitting ? "Take Off Air" : "Push On Air (Live)" }}
      </button>
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
      <div>
        <dt>Message</dt>
        <dd>{{ tx.message || sessionPlayback.message || "--" }}</dd>
      </div>
    </dl>
  </aside>
</template>
