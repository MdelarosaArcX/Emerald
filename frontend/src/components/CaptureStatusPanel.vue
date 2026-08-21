<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useCaptureHealthStore } from "../stores/captureHealth";
import { useDatabasesStore, type DbCheck } from "../stores/databases";
import { useSessionPlaybackStore } from "../stores/sessionPlayback";
import { useRecorderStore } from "../stores/recorder";

const captureHealth = useCaptureHealthStore();
const databases = useDatabasesStore();
const sessionPlayback = useSessionPlaybackStore();
const recorder = useRecorderStore();

const dbChecks = computed(() => [databases.db1, databases.db2, databases.db3]);

function dbTitle(db: DbCheck | null) {
  if (!db) return "Checking...";
  if (!db.connected) return db.error || "Not connected";
  return `${db.host || ""}${db.latencyMs != null ? ` — ${db.latencyMs}ms` : ""}`;
}

// Both the archival (high-res) and proxy legs write into the same per-session folder (see
// obsIngestService.js's start() — one ffmpeg process, one sessionDir, two segment patterns) —
// this just strips the "emerald-%03d.ext" filename pattern down to that shared directory.
function directoryOf(pattern: string | null | undefined) {
  if (!pattern) return "No active session";
  return pattern.replace(/[\\/][^\\/]*$/, "");
}

const highResDest = computed(() => directoryOf(recorder.recorderStatus?.archivalOutputPattern));
const proxyDest = computed(() => directoryOf(recorder.recorderStatus?.outputPattern));
const capturedFileDuration = computed(() => `${recorder.recorderStatus?.segmentSeconds ?? recorder.settings.segmentSeconds}s`);

// Derived from two real values (the configured size cap + the actual encode bitrate) rather than
// a live-measured "time until full" — genuinely accurate as long as both hold, but an estimate.
const maxCaptureFileSizeLabel = computed(() => {
  const bytes = recorder.recorderStatus?.recordingSizeLimitBytes;
  if (!bytes) return "No limit configured";

  const gb = bytes / 1024 ** 3;
  const totalKbps = (captureHealth.data?.capture.videoBitrateKbps ?? 0) + (captureHealth.data?.capture.audioBitrateKbps ?? 0);
  const minutesLabel = totalKbps > 0 ? ` (${Math.round(bytes * 8 / (totalKbps * 1000) / 60)} mins)` : "";
  return `${gb.toFixed(0)} GB${minutesLabel}`;
});

const audioCapturedLabel = computed(() => `${(captureHealth.data?.capture.audioCapturedMs ?? 0).toLocaleString()} ms`);
const audioDroppedLabel = computed(() => {
  const capture = captureHealth.data?.capture;
  if (!capture || capture.audioBitrateKbps == null) return "No audio";
  return String(capture.framesDropped);
});

// "Gen" rather than "Locked" for the healthy case: the panel already has a "Tidal Lock" column
// and a row of up/down dots, so a second thing shouting LOCKED reads as if it's about the same
// subject. This one is specifically about the timecode generator.
const timecodeLockLabel = computed(() => {
  switch (captureHealth.timecodeLockState) {
    case "LOCKED": return "Gen";
    case "MISMATCH": return "TZ mismatch";
    default: return "Free run";
  }
});

let healthHandle: number | null = null;
let dbHandle: number | null = null;

onMounted(() => {
  captureHealth.refresh();
  databases.refresh();
  healthHandle = window.setInterval(() => captureHealth.refresh(), 1000);
  dbHandle = window.setInterval(() => databases.refresh(), 5000);
});

onUnmounted(() => {
  if (healthHandle) window.clearInterval(healthHandle);
  if (dbHandle) window.clearInterval(dbHandle);
});
</script>

<template>
  <section class="status-panel">
    <div class="status-band">
      <div class="status-band-col">
        <h3 class="status-title">Database Connect</h3>
        <div class="status-chips">
          <span v-for="(db, index) in dbChecks" :key="index" class="status-chip" :title="dbTitle(db)">
            <i class="status-dot" :class="db ? (db.connected ? 'up' : 'down') : ''"></i>
            {{ db?.label || `DB${index + 1}` }}
          </span>
        </div>
      </div>

      <div class="status-band-col">
        <h3 class="status-title">Tidal Lock</h3>
        <div class="status-chips">
          <span class="status-chip">
            <i class="status-dot" :class="sessionPlayback.tidalLockEnabled ? 'up' : 'down'"></i>
            {{ sessionPlayback.tidalLockEnabled ? "Engaged" : "Disengaged" }}
          </span>
          <span v-if="sessionPlayback.tidalLockedFolder" class="status-subtext">{{ sessionPlayback.tidalLockedFolder }}</span>
        </div>
      </div>

      <div class="status-band-col status-band-col-end">
        <h3 class="status-title">Timecode</h3>
        <span class="status-timecode">{{ captureHealth.data?.timecode || "--:--:--:--" }}</span>
        <!-- Whether that number is the generator's or a local stand-in. Without this a FREE_RUN
             fallback is indistinguishable from a real lock, and an operator would only find out
             the recordings were stamped from the wrong clock afterwards. -->
        <span
          v-if="captureHealth.timecodeLockState"
          class="status-chip timecode-lock"
          :class="captureHealth.timecodeLockState.toLowerCase()"
          :title="captureHealth.timecodeLockDetail"
        >
          <i class="status-dot" :class="captureHealth.timecodeIsLocked ? 'up' : 'down'"></i>
          {{ timecodeLockLabel }}
        </span>
      </div>
    </div>

    <div class="status-card">
      <h3 class="status-title">Capture Card</h3>
      <div class="status-chips">
        <span class="status-chip" :title="captureHealth.data ? '' : 'DeltacastCaptureService unreachable'">
          <i class="status-dot" :class="captureHealth.data?.capture.isCapturing ? 'up' : 'down'"></i>
          {{ captureHealth.channelLabel === "--" ? "Unavailable" : captureHealth.channelLabel }}
        </span>
        <span v-if="captureHealth.data?.capture.sdiInterface" class="status-subtext">{{ captureHealth.data.capture.sdiInterface }}</span>
      </div>
      <!-- Only while capture is down: this is the reason the Capture preview is black, which is
           otherwise indistinguishable in the browser from a preview that simply hasn't started. -->
      <p
        v-if="!captureHealth.data?.capture.isCapturing && captureHealth.data?.capture.lastMessage"
        class="status-subtext status-reason"
      >{{ captureHealth.data.capture.lastMessage }}</p>
    </div>

    <div class="status-card">
      <h3 class="status-title">Destination</h3>
      <div class="config-grid-2col">
        <dl class="stats">
          <div>
            <dt>High-res Dest.</dt>
            <dd :title="highResDest">{{ highResDest }}</dd>
          </div>
          <div>
            <dt>High-res Files</dt>
            <dd>MOV / ProRes 422</dd>
          </div>
        </dl>
        <dl class="stats">
          <div>
            <dt>Proxy Dest.</dt>
            <dd :title="proxyDest">{{ proxyDest }}</dd>
          </div>
          <div>
            <dt>Proxy Files</dt>
            <dd>MP4 / H.264</dd>
          </div>
        </dl>
      </div>
    </div>

    <div class="status-card">
      <h3 class="status-title">Configuration</h3>
      <div class="config-grid-2col">
        <dl class="stats">
          <div>
            <dt>Video Source</dt>
            <dd>{{ captureHealth.data?.capture.sdiInterface || "--" }}</dd>
          </div>
          <div>
            <dt>Video Format</dt>
            <dd>{{ captureHealth.videoFormatLabel || "--" }}</dd>
          </div>
          <div>
            <dt>Current Video Data rate</dt>
            <dd>{{ captureHealth.videoDataRateLabel }}</dd>
          </div>
          <div>
            <dt>Current Audio Data rate</dt>
            <dd>{{ captureHealth.audioDataRateLabel }}</dd>
          </div>
          <div>
            <dt>Captured File Duration</dt>
            <dd>{{ capturedFileDuration }}</dd>
          </div>
          <div>
            <dt>Max Capture File Size</dt>
            <dd>{{ maxCaptureFileSizeLabel }}</dd>
          </div>
          <div>
            <dt>Audio Channels</dt>
            <dd>
              <span v-if="captureHealth.data?.capture.audioChannelDetected" class="status-chips">
                <span class="status-chip"><i class="status-dot up"></i>Stereo 1</span>
              </span>
              <span v-else>No audio channels active</span>
            </dd>
          </div>
        </dl>
        <dl class="stats">
          <div>
            <dt>Video Framecount</dt>
            <dd>{{ captureHealth.data?.capture.framesReceived ?? "--" }}</dd>
          </div>
          <div>
            <dt>Video Frames Dropped</dt>
            <dd>{{ captureHealth.data?.capture.framesDropped ?? "--" }}</dd>
          </div>
          <div>
            <dt>Video Buffer Size</dt>
            <dd>{{ captureHealth.data?.capture.bufferCapacity ?? "--" }}</dd>
          </div>
          <div>
            <dt>Video Buffer In use</dt>
            <dd>{{ captureHealth.data?.capture.bufferInUse ?? "--" }}</dd>
          </div>
          <div>
            <dt>Audio Captured</dt>
            <dd>{{ audioCapturedLabel }}</dd>
          </div>
          <div>
            <dt>Audio Dropped</dt>
            <dd>{{ audioDroppedLabel }}</dd>
          </div>
          <div>
            <dt>Audio Buffer Size</dt>
            <dd>{{ captureHealth.data?.capture.bufferCapacity ?? "--" }}</dd>
          </div>
          <div>
            <dt>Audio Buffer In Use</dt>
            <dd>{{ captureHealth.data?.capture.bufferInUse ?? "--" }}</dd>
          </div>
        </dl>
      </div>
    </div>
  </section>
</template>
