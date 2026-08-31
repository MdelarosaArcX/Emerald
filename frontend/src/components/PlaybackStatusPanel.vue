<script setup lang="ts">
/**
 * What playout is doing and how it is configured — the counterpart to CaptureStatusPanel, sitting
 * above the playback log in the same tab.
 *
 * Deliberately reports rather than configures: the controls live in the Playback Deck, and a second
 * set of them here would let two panels disagree about which is in force. What this adds is the
 * running state the deck has no room for — which segment is on air, how far into it, and what the
 * transmission is actually made of.
 */
import { computed, onMounted, onUnmounted } from "vue";
import { usePlaybackLogStore } from "../stores/playbackLog";
import { useSessionPlaybackStore } from "../stores/sessionPlayback";
import { useAirInsertStore } from "../stores/airInsert";
import { useDeltacastHardwareStore } from "../stores/deltacastHardware";
import { useTxStore } from "../stores/tx";

const playbackLog = usePlaybackLogStore();
const sessionPlayback = useSessionPlaybackStore();
const airInsert = useAirInsertStore();
const hardware = useDeltacastHardwareStore();
const tx = useTxStore();

let refreshHandle: number | null = null;

const selectedSession = computed(() =>
  sessionPlayback.sessions.find((session) => session.folder === sessionPlayback.selectedFolder));

const currentSegmentLabel = computed(() => playbackLog.currentSegment?.fileName || "--");

const segmentPositionLabel = computed(() => {
  const segment = playbackLog.currentSegment;
  if (!segment) return "--";
  const offset = playbackLog.currentOffsetSeconds;
  const total = segment.durationSeconds;
  return total ? `${offset.toFixed(1)}s / ${total.toFixed(1)}s` : `${offset.toFixed(1)}s`;
});

const txChannelLabel = computed(() => (tx.status ? `TX${tx.status.channelIndex}` : "--"));

/**
 * Whether the timecode on this page is the generator's. FREE_RUN means the generator was
 * unreachable and the backend's own clock is standing in; MISMATCH means it answered but disagrees
 * by more than a frame, which in practice is a timezone difference between the two machines.
 */
const timecodeSourceLabel = computed(() => {
  switch (playbackLog.timecodeLockState) {
    case "LOCKED": return "Generator (locked)";
    case "MISMATCH": return "Generator — timezone mismatch";
    case "FREE_RUN": return "Free run — generator unreachable";
    default: return "--";
  }
});

const rxPreviewLabel = computed(() => {
  const leg = hardware.inUse?.onAirPreview;
  if (!leg) return "Unknown";
  if (leg.enabled === false) return "Off — TX software mirror";
  return `RX${leg.channelIndex}${leg.active ? " (signal)" : " (no signal)"}`;
});

const onAirLabel = computed(() => {
  if (!tx.status) return "Unknown";
  if (!tx.isTransmitting) return `Off air (${txChannelLabel.value})`;
  return tx.isStalled ? `${txChannelLabel.value} stalled` : `${txChannelLabel.value} live`;
});

const bookedClipsLabel = computed(() => {
  if (!airInsert.inserts.length) return "None";
  const inserts = airInsert.inserts.filter((entry) => entry.mode === "insert").length;
  const overlays = airInsert.inserts.length - inserts;
  return [inserts ? `${inserts} insert` : "", overlays ? `${overlays} overlay` : ""]
    .filter(Boolean)
    .join(", ");
});

function formatSize(size?: number) {
  if (!size) return "--";
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

onMounted(async () => {
  await Promise.all([sessionPlayback.loadSessions(), sessionPlayback.loadRecorderStatus(), tx.refresh(), hardware.fetch()]);
  refreshHandle = window.setInterval(() => {
    sessionPlayback.loadSessions();
    sessionPlayback.loadRecorderStatus();
    tx.refresh();
  }, 5000);
});

onUnmounted(() => {
  if (refreshHandle) window.clearInterval(refreshHandle);
});
</script>

<template>
  <section class="status-panel" aria-label="Playback status">
    <div class="status-card">
      <h3 class="status-title">Playout</h3>
      <div class="config-grid-2col">
        <dl class="stats">
          <div>
            <dt>Recording Folder</dt>
            <dd :title="sessionPlayback.selectedFolder">{{ sessionPlayback.selectedFolder || "None selected" }}</dd>
          </div>
          <div>
            <dt>Playing Segment</dt>
            <dd :title="currentSegmentLabel">{{ currentSegmentLabel }}</dd>
          </div>
          <div>
            <dt>Position In Segment</dt>
            <dd>{{ segmentPositionLabel }}</dd>
          </div>
          <div>
            <dt>Playout Timecode</dt>
            <dd>{{ playbackLog.currentTimecode || "--" }}</dd>
          </div>
          <div>
            <dt>Up Next</dt>
            <dd :title="playbackLog.nextUp?.fileName">
              {{ playbackLog.nextUp
                ? `${playbackLog.nextUp.fileName} at ${playbackLog.nextUp.timecode}`
                : "Nothing queued" }}
            </dd>
          </div>
        </dl>
        <dl class="stats">
          <div>
            <dt>On Air</dt>
            <dd>{{ onAirLabel }}</dd>
          </div>
          <div>
            <dt>TX Frames</dt>
            <dd v-if="tx.isTransmitting">{{ tx.status?.framesSent ?? 0 }} sent, {{ tx.status?.framesDropped ?? 0 }} dropped</dd>
            <dd v-else>--</dd>
          </div>
          <div>
            <dt>Tidal Lock</dt>
            <dd>{{ sessionPlayback.tidalLockEnabled ? "Engaged" : "Off" }}</dd>
          </div>
          <div>
            <dt>Booked Clips</dt>
            <dd>{{ bookedClipsLabel }}</dd>
          </div>
        </dl>
      </div>
    </div>

    <div class="status-card">
      <h3 class="status-title">Configuration</h3>
      <div class="config-grid-2col">
        <dl class="stats">
          <div>
            <dt>RX Preview</dt>
            <dd>{{ rxPreviewLabel }}</dd>
          </div>
          <div>
            <dt>Transmit Channel</dt>
            <dd>
              {{ hardware.inUse ? `Board ${hardware.inUse.transmit.boardIndex} — TX${hardware.inUse.transmit.channelIndex}` : "--" }}
            </dd>
          </div>
          <div>
            <dt>Transmit Format</dt>
            <dd>
              {{ hardware.inUse
                ? `${hardware.inUse.transmit.width}x${hardware.inUse.transmit.height}@${hardware.inUse.transmit.frameRate}`
                : "--" }}
            </dd>
          </div>
          <div>
            <dt>Timecode Source</dt>
            <dd :class="{ 'tc-warn': playbackLog.timecodeLockState && playbackLog.timecodeLockState !== 'LOCKED' }">
              {{ timecodeSourceLabel }}
            </dd>
          </div>
          <div>
            <dt>Broadcast Delay</dt>
            <dd>{{ sessionPlayback.recorder?.broadcastDelaySeconds ?? "--" }}s</dd>
          </div>
          <div>
            <dt>Segment Length</dt>
            <dd>{{ sessionPlayback.recorder?.segmentSeconds ?? "--" }}s</dd>
          </div>
        </dl>
        <dl class="stats">
          <div>
            <dt>Segments Available</dt>
            <dd>{{ playbackLog.segments.length || "--" }}</dd>
          </div>
          <div>
            <dt>Session Size</dt>
            <dd>{{ formatSize(selectedSession?.size) }}</dd>
          </div>
          <div>
            <dt>Session State</dt>
            <dd>{{ selectedSession?.isActive ? "Recording" : "Finished" }}</dd>
          </div>
          <div>
            <dt>Clip Lead Time</dt>
            <dd>{{ airInsert.minLeadSeconds }}s minimum</dd>
          </div>
          <div>
            <dt>Message</dt>
            <dd :title="tx.message || sessionPlayback.message">{{ tx.message || sessionPlayback.message || "--" }}</dd>
          </div>
        </dl>
      </div>
    </div>
  </section>
</template>
