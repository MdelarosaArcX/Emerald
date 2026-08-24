<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRecorderStore } from "../stores/recorder";
import { useAudioCalibrationStore } from "../stores/audioCalibration";
import { useCaptureHealthStore } from "../stores/captureHealth";
import { useDeltacastHardwareStore } from "../stores/deltacastHardware";

const recorder = useRecorderStore();
const audioCalibration = useAudioCalibrationStore();
const captureHealth = useCaptureHealthStore();
const hardware = useDeltacastHardwareStore();

/**
 * The capture leg's board/channel, as the service has them configured.
 *
 * Read from the hardware report rather than held in this panel's own settings because they are not
 * this panel's to own: they live in DeltacastCaptureService's appsettings.json and are read once at
 * startup, since the SDI channel a capture is bound to cannot be swapped under a running stream.
 * Selecting here therefore stages a change and says a restart is needed, rather than pretending it
 * took effect.
 */
const captureBoard = computed({
  get: () => stagedCaptureBoard.value ?? hardware.inUse?.capture.boardIndex ?? 0,
  set: (value: number) => {
    stagedCaptureBoard.value = Number(value);
    // A channel index only means anything against a board — keeping the old one across a board
    // change would silently point at a different physical connector, or at none.
    stagedCaptureChannel.value = hardware.rxChannels(Number(value))[0]?.channelIndex ?? 0;
  },
});

const captureChannel = computed({
  get: () => stagedCaptureChannel.value ?? hardware.inUse?.capture.channelIndex ?? 0,
  set: (value: number) => { stagedCaptureChannel.value = Number(value); },
});

const stagedCaptureBoard = ref<number | null>(null);
const stagedCaptureChannel = ref<number | null>(null);

/** True once a selection differs from what the service is actually running. */
const captureSelectionChanged = computed(() =>
  hardware.inUse !== null
  && (captureBoard.value !== hardware.inUse.capture.boardIndex
    || captureChannel.value !== hardware.inUse.capture.channelIndex),
);

/**
 * The geometry actually being captured, which is what an operator wants to see here.
 *
 * The configured Width/Height are only a fallback: the capture leg follows the video standard the
 * board detects on the wire (see DeltacastSdkService), so showing the configured pair as if it were
 * the truth would misreport a 1080i source as whatever appsettings happened to say.
 */
const captureGeometry = computed(() => {
  const leg = hardware.inUse?.capture;
  if (!leg) return "—";
  if (leg.detectedWidth && leg.detectedHeight) {
    const rate = leg.detectedFrameRate ? `@${leg.detectedFrameRate}` : "";
    return `${leg.detectedWidth}x${leg.detectedHeight}${rate}${leg.detectedStandard ? ` · ${leg.detectedStandard}` : ""} (detected)`;
  }
  return `${leg.width ?? "—"}x${leg.height ?? "—"} (configured, no signal)`;
});

const activeStreams = computed(() => recorder.ingestStatus?.activeStreams.join(", ") || "None");
const recordingCount = computed(() => recorder.recordings.length);
const durationTimecode = computed({
  get: () => formatTimecode(recorder.settings.segmentSeconds),
  set: (value: string) => {
    recorder.settings.segmentSeconds = parseTimecode(value);
  },
});
const broadcastDelayTimecode = computed({
  get: () => formatTimecode(recorder.settings.broadcastDelaySeconds),
  set: (value: string) => {
    recorder.settings.broadcastDelaySeconds = parseTimecode(value);
  },
});

watch(
  () => recorder.settings,
  () => recorder.saveSettings(),
  { deep: true }
);

// The frame base the calibration's frame readout is counted in — the generator's when we're
// locked to it, since that's what the timecode is counted in too.
const calibrationFps = computed(() =>
  Math.max(1, captureHealth.data?.timecodeSource?.frameRate || Number(recorder.settings.fps) || 25),
);
const msPerFrame = computed(() => 1000 / calibrationFps.value);
const audioOffsetFramesLabel = computed(() => {
  const frames = audioCalibration.offsetMs / msPerFrame.value;
  // Two decimals: sub-frame corrections are the common case, and rounding to whole frames would
  // make most real settings display as "0 frames" while the ms field clearly says otherwise.
  return `${frames >= 0 ? "+" : ""}${frames.toFixed(2)} f`;
});

const audioOffsetMs = computed({
  get: () => audioCalibration.offsetMs,
  set: (value: number | string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) audioCalibration.set(parsed);
  },
});

// Positive delays audio relative to video, so "audio is early, push it later" is the + direction.
function stepAudioOffset(frames: number) {
  audioCalibration.set(audioCalibration.offsetMs + frames * msPerFrame.value);
}

let calibrationHandle: number | null = null;

let hardwareHandle: number | null = null;

onMounted(() => {
  audioCalibration.refresh();
  // Slow poll: this value only changes when someone changes it, but the capture service can
  // restart underneath us and the control needs to notice it came back.
  calibrationHandle = window.setInterval(() => audioCalibration.refresh(), 5000);

  // The board list itself is static, but which channels carry signal and which leg holds what is
  // not — and the service restarting is exactly when this panel needs to notice.
  hardware.fetch();
  hardwareHandle = window.setInterval(() => hardware.fetch(), 5000);
});

onUnmounted(() => {
  if (calibrationHandle) window.clearInterval(calibrationHandle);
  if (hardwareHandle) window.clearInterval(hardwareHandle);
});

function formatTimecode(totalSeconds: number) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(remainder)}:00`;
}

function parseTimecode(value: string) {
  const [hours = "0", minutes = "0", seconds = "0"] = value.split(":");
  return (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60 + (Number(seconds) || 0);
}

function pad(value: number) {
  return String(Math.trunc(value)).padStart(2, "0");
}
</script>

<template>
  <aside class="recording-card">
    <header class="recording-header">
      <span class="radio-dot" :class="{ live: recorder.isRecording }"></span>
      <h2>Recording Configuration</h2>
    </header>

    <div class="config-grid">
      <label class="field-row field-wide">
        <span>Title</span>
        <input v-model="recorder.settings.title" class="value-input" placeholder="Click to add title" />
      </label>

      <label class="field-row field-wide">
        <span>Description</span>
        <input v-model="recorder.settings.description" class="value-input" placeholder="Click to add description" />
      </label>

      <label class="field-row">
        <span>Set Duration</span>
        <input v-model="durationTimecode" class="compact-input" inputmode="numeric" />
      </label>

      <label class="field-row" title="Deliberate gap between capturing a segment and it becoming eligible to go on air (Tidal Lock / Push On Air) — a review window before it airs. 00:00:00:00 disables it.">
        <span>Broadcast Delay</span>
        <input v-model="broadcastDelayTimecode" class="compact-input" inputmode="numeric" />
      </label>

      <!-- SDI capture source. Enumerated from the hardware itself, so the lists only ever contain
           boards and channels that physically exist — see stores/deltacastHardware.ts. -->
      <label class="field-row field-wide" title="Which DELTACAST board the programme feed is captured from.">
        <span>Capture Board</span>
        <select
          v-model.number="captureBoard"
          class="compact-select auto-select"
          :disabled="!hardware.inventoryAvailable"
        >
          <option v-for="board in hardware.rxBoards" :key="board.boardIndex" :value="board.boardIndex">
            {{ board.label }} — {{ board.rxChannelCount }} RX / {{ board.txChannelCount }} TX
          </option>
          <option v-if="!hardware.rxBoards.length" :value="captureBoard">
            {{ hardware.loading ? "Reading hardware…" : "No SDI boards detected" }}
          </option>
        </select>
      </label>

      <label class="field-row field-wide" title="Which SDI input on that board. 'signal' means the board has locked to something on that connector right now.">
        <span>Capture Channel</span>
        <select
          v-model.number="captureChannel"
          class="compact-select auto-select"
          :disabled="!hardware.inventoryAvailable"
        >
          <option
            v-for="channel in hardware.rxChannels(captureBoard)"
            :key="channel.channelIndex"
            :value="channel.channelIndex"
          >
            {{ hardware.channelLabel(captureBoard, channel.channelIndex, "rx") }}
          </option>
          <option v-if="!hardware.rxChannels(captureBoard).length" :value="captureChannel">
            No SDI inputs on this board
          </option>
        </select>
      </label>

      <!-- Resolution is reported, not chosen: the capture leg follows the standard the board
           detects on the wire, so offering it as a setting would be offering a lie. -->
      <div class="field-row field-wide" title="The video standard the board has detected on the selected input. Capture follows the signal rather than a configured size.">
        <span>Capture Format</span>
        <span class="value-static">{{ captureGeometry }}</span>
      </div>

      <p v-if="captureSelectionChanged" class="hardware-note">
        Board/channel staged — DeltacastCaptureService reads these once at startup, so restart it to
        capture from {{ hardware.channelLabel(captureBoard, captureChannel, "rx").split(" (")[0] }}
        on board {{ captureBoard }}.
      </p>
      <p v-else-if="hardware.message" class="hardware-note warn">{{ hardware.message }}</p>

      <!-- Lip-sync calibration. Applies to the live preview within about a second so it can be
           tuned by eye; a running recording keeps the value it started with. -->
      <div
        class="field-row field-wide audio-sync-row"
        :class="{ disabled: !audioCalibration.available }"
        :title="audioCalibration.available
          ? 'Shifts audio relative to video. Positive delays audio, negative advances it. Takes effect on the live preview within about a second; a recording already running keeps the value it started with.'
          : 'DeltacastCaptureService is unreachable — audio calibration unavailable.'"
      >
        <span>Audio Sync</span>
        <span class="audio-sync-controls">
          <button
            type="button"
            class="audio-sync-step"
            :disabled="!audioCalibration.available"
            title="One frame earlier"
            @click="stepAudioOffset(-1)"
          >−</button>
          <input
            v-model.number="audioOffsetMs"
            class="compact-input audio-sync-input"
            type="number"
            step="1"
            inputmode="numeric"
            :disabled="!audioCalibration.available"
          />
          <span class="audio-sync-unit">ms</span>
          <button
            type="button"
            class="audio-sync-step"
            :disabled="!audioCalibration.available"
            title="One frame later"
            @click="stepAudioOffset(1)"
          >+</button>
          <span class="audio-sync-frames">{{ audioOffsetFramesLabel }}</span>
          <!-- Applying the value restarts the preview encoder, so the picture hitches for a
               moment. Saying so turns an unexplained glitch into expected feedback. -->
          <span v-if="audioCalibration.saving" class="audio-sync-applying">re-syncing…</span>
          <button
            type="button"
            class="audio-sync-step audio-sync-reset"
            :disabled="!audioCalibration.available || audioCalibration.offsetMs === 0"
            title="Reset to zero"
            @click="audioCalibration.set(0)"
          >0</button>
        </span>
      </div>

      <label class="field-row">
        <span>FPS</span>
        <select v-model="recorder.settings.fps" class="compact-select">
          <option value="25">25 DVB-T</option>
          <option value="30">30 DVB-T</option>
          <option value="60">60 DVB-T</option>
        </select>
      </label>

      <label class="field-row field-wide">
        <span>Format</span>
        <span class="format-controls">
          <select v-model="recorder.settings.container" class="compact-select auto-select">
            <option value="mov">MOV</option>
            <option value="mp4">MP4</option>
            <option value="mkv">Auto detect - MKV</option>
            <option value="ts">Auto detect - MPEG-TS</option>
          </select>
          <select v-model="recorder.settings.videoCodec" class="compact-select auto-select">
            <option value="ProRes 422">ProRes 422</option>
            <option value="H.264">Auto detect - H.264</option>
            <option value="H.265">Auto detect - H.265</option>
          </select>
          <select v-model="recorder.settings.audioCodec" class="compact-select auto-select">
            <option value="AAC">Auto detect - AAC</option>
            <option value="Opus">Auto detect - Opus</option>
          </select>
        </span>
      </label>

      <label class="field-row">
        <span>Video Bitrate</span>
        <select v-model="recorder.settings.videoBitrate" class="compact-select auto-select">
          <option value="3000 kbps">Auto detect - 3000 kbps</option>
          <option value="5000 kbps">Auto detect - 5000 kbps</option>
          <option value="8000 kbps">Auto detect - 8000 kbps</option>
        </select>
      </label>

      <label class="field-row">
        <span>Audio Bitrate</span>
        <select v-model="recorder.settings.audioBitrate" class="compact-select auto-select">
          <option value="320 kbps">Auto detect - 320 kbps</option>
          <option value="256 kbps">Auto detect - 256 kbps</option>
          <option value="128 kbps">Auto detect - 128 kbps</option>
        </select>
      </label>

      <label class="field-row">
        <span>Audio Sample Frequency</span>
        <select v-model="recorder.settings.audioSampleFrequency" class="compact-select auto-select">
          <option value="96 kHz">Auto detect - 96 kHz</option>
          <option value="48 kHz">Auto detect - 48 kHz</option>
          <option value="44.1 kHz">Auto detect - 44.1 kHz</option>
        </select>
      </label>
    </div>

    <div class="recorder-advanced">
      <label class="field-row source-field">
        <span>Source URL</span>
        <input v-model="recorder.settings.inputUrl" placeholder="udp://0.0.0.0:5000" />
      </label>

      <label class="field-row">
        <span>FFmpeg Path</span>
        <input v-model="recorder.settings.ffmpegPath" placeholder="ffmpeg or C:\ffmpeg\bin\ffmpeg.exe" />
      </label>
    </div>

    <dl class="stats recorder-advanced">
      <div>
        <dt>RTMP Ingest</dt>
        <dd>{{ recorder.ingestStatus?.lastMessage || "--" }}</dd>
      </div>
      <div>
        <dt>Active Streams</dt>
        <dd>{{ activeStreams }}</dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>{{ recorder.recorderStatus?.outputPattern || "--" }}</dd>
      </div>
      <div>
        <dt>Saved Segments</dt>
        <dd>{{ recordingCount }}</dd>
      </div>
      <div>
        <dt>Message</dt>
        <dd>{{ recorder.message || "--" }}</dd>
      </div>
    </dl>

    <ol class="segments recorder-advanced">
      <li v-for="recording in recorder.recordings" :key="recording.fileName">
        <a :href="recording.url" target="_blank" rel="noreferrer">{{ recording.fileName }}</a>
        <span>{{ Math.round(recording.size / 1024) }} KB</span>
      </li>
    </ol>
  </aside>
</template>
