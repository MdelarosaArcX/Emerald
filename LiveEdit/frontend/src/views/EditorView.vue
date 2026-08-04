<script setup lang="ts">
/**
 * The Live Editor route: the primary broadcast-style workspace combining
 * capture preview, program monitor, live playback monitor, inspector,
 * and the multi-track timeline in a resizable split layout.
 */
import CaptureDeck from '@/components/capture/CaptureDeck.vue';
import LiveEditDeck from '@/components/capture/LiveEditDeck.vue';
import EffectsPanel from '@/components/inspector/EffectsPanel.vue';
import InspectorPanel from '@/components/inspector/InspectorPanel.vue';
import ProgramMonitor from '@/components/monitor/ProgramMonitor.vue';
import PlaybackMonitor from '@/components/monitor/PlaybackMonitor.vue';
import TimelineEditor from '@/components/timeline/TimelineEditor.vue';
import { fetchActiveRecording, fetchSessionSegments } from '@/services/emeraldPreview';
import { useCaptureStore } from '@/stores/captureStore';
import { useIngestStore } from '@/stores/ingestStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProgramStore } from '@/stores/programStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useIntervalFn } from '@vueuse/core';
import 'splitpanes/dist/splitpanes.css';
import { Pane, Splitpanes } from 'splitpanes';
import { onMounted, ref, watch } from 'vue';

const timelineStore = useTimelineStore();
const playbackStore = usePlaybackStore();
const captureStore = useCaptureStore();
const programStore = useProgramStore();
const settingsStore = useSettingsStore();
const ingestStore = useIngestStore();

// --- On-air highlight ------------------------------------------------------------------------
// The red timeline band marks how much of the sequence has gone/is going to air. It's the live
// capture edge (the recorded length) minus the broadcast delay, advancing in real time. Anchored
// on load and then ticked so it moves smoothly between the (chunky) segment appends.
const BROADCAST_DELAY_SECONDS = 7; // matches the header DELAY readout
let onAirAnchorFrame = 0;
let onAirAnchorAt = 0;
function anchorOnAir(): void {
  const fps = timelineStore.fps || 25;
  onAirAnchorFrame = Math.max(0, timelineStore.duration - Math.round(BROADCAST_DELAY_SECONDS * fps));
  onAirAnchorAt = performance.now();
}
useIntervalFn(() => {
  if (!ingestStore.liveFolder || !ingestStore.recording) {
    if (timelineStore.onAirFrame !== 0) timelineStore.setOnAirFrame(0);
    return;
  }
  const fps = timelineStore.fps || 25;
  const elapsed = (performance.now() - onAirAnchorAt) / 1000;
  timelineStore.setOnAirFrame(onAirAnchorFrame + elapsed * fps);
}, 250);

// Load a recording session as a live-ingesting timeline sequence.
async function loadLiveSession(folder: string, segmentSeconds: number): Promise<void> {
  ingestStore.setLoading(folder); // show the "loading clips…" indicator (the fetch can be slow)
  try {
    const segs = await fetchSessionSegments(folder);
    if (!segs.length) return;
    timelineStore.loadSession({
      folder,
      fps: programStore.fps,
      nominalSeconds: segmentSeconds,
      segments: segs.map((s) => ({ fileName: s.fileName, url: s.url, thumbnail: s.thumbnailUrl, index: s.index })),
    });
    ingestStore.startLive(folder, segmentSeconds);
    lastAutoFolder = folder;
    anchorOnAir();
  } finally {
    ingestStore.setLoading(null);
  }
}

// In Live Edit mode, if a recording is happening it's auto-loaded onto the timeline. Each distinct
// recording is auto-loaded at most once (lastAutoFolder), so a manual load of a past session isn't
// repeatedly overridden — but a NEW recording (rotation) does get picked up.
let lastAutoFolder: string | null = null;
async function maybeAutoLoadLive(optimistic = false): Promise<void> {
  if (!settingsStore.liveEditMode || ingestStore.liveFolder) return;
  // On a user-driven trigger (toggling into Live Edit), show the indicator right away so the wait
  // for the (sometimes slow) recorder status isn't a silent gap. The 6s poller skips this to avoid
  // flicker when there's simply no recording.
  if (optimistic) ingestStore.setLoading('live session');
  try {
    const status = await fetchActiveRecording();
    ingestStore.setRecording(status.isRecording);
    if (!status.isRecording || !status.folder) return;
    if (ingestStore.loadedFolder === status.folder || lastAutoFolder === status.folder) return;
    await loadLiveSession(status.folder, status.segmentSeconds);
  } finally {
    if (optimistic && !ingestStore.liveFolder) ingestStore.setLoading(null);
  }
}

// Live ingest: auto-load the live recording (in Live Edit mode), then while a live session is loaded
// poll for newly-recorded segments and append them so the editor keeps receiving what's recorded.
useIntervalFn(async () => {
  const folder = ingestStore.liveFolder;
  if (!folder) {
    await maybeAutoLoadLive();
    return;
  }
  const [segs, status] = await Promise.all([fetchSessionSegments(folder), fetchActiveRecording()]);
  if (segs.length) {
    timelineStore.appendSessionSegments({
      folder,
      fps: timelineStore.fps,
      nominalSeconds: ingestStore.segmentSeconds,
      segments: segs.map((s) => ({ fileName: s.fileName, url: s.url, thumbnail: s.thumbnailUrl, index: s.index })),
    });
  }
  ingestStore.setRecording(status.isRecording);
  if (!status.isRecording || status.folder !== folder) ingestStore.stopLive();
}, 6000);

// Auto-load the moment Live Edit mode is switched on (don't wait for the next poll tick).
watch(() => settingsStore.liveEditMode, (on) => {
  if (on) void maybeAutoLoadLive(true);
});

// The information/inspector drawer ("Video / Audio FX") is collapsed by default so the timeline
// spans the full width, matching the broadcast layout. Toggled from the right-panel FX tab or the
// timeline header — and auto-opened when a clip is loaded so its details are visible immediately.
const inspectorOpen = ref(false);
function toggleInspector(): void {
  inspectorOpen.value = !inspectorOpen.value;
}
watch(() => programStore.clip, (clip) => {
  if (clip) inspectorOpen.value = true;
});

onMounted(async () => {
  await timelineStore.fetchTimeline();
  timelineStore.subscribeToSocket();
  playbackStore.subscribeToSocket();
  captureStore.subscribeToSocket();
  void maybeAutoLoadLive(true);
});
</script>

<template>
  <div class="flex h-full flex-col gap-3 p-3">
    <Splitpanes class="min-h-0 flex-1" horizontal>
      <Pane :size="72">
        <Splitpanes class="h-full">
          <Pane :size="22" :min-size="16">
            <LiveEditDeck v-if="settingsStore.liveEditMode" />
            <CaptureDeck v-else />
          </Pane>
          <Pane :size="56" :min-size="30">
            <ProgramMonitor />
          </Pane>
          <Pane :size="22" :min-size="16">
            <EffectsPanel v-if="settingsStore.liveEditMode" />
            <PlaybackMonitor v-else :inspector-open="inspectorOpen" @toggle-inspector="toggleInspector" />
          </Pane>
        </Splitpanes>
      </Pane>
      <Pane :size="28" :min-size="15">
        <div class="flex h-full gap-3 pt-3">
          <TimelineEditor class="min-w-0 flex-1" :inspector-open="inspectorOpen" @toggle-inspector="toggleInspector" />
          <InspectorPanel v-if="inspectorOpen" />
        </div>
      </Pane>
    </Splitpanes>
  </div>
</template>

<style>
.splitpanes.default-theme .splitpanes__pane {
  background: transparent;
}
.splitpanes--vertical > .splitpanes__splitter,
.splitpanes--horizontal > .splitpanes__splitter {
  background: transparent;
  position: relative;
}
.splitpanes--vertical > .splitpanes__splitter {
  width: 6px;
  margin: 0 -1px;
}
.splitpanes--horizontal > .splitpanes__splitter {
  height: 6px;
  margin: -1px 0;
}
.splitpanes__splitter::before {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  border-radius: 4px;
  transition: background-color 0.15s ease;
}
.splitpanes--vertical > .splitpanes__splitter::before {
  width: 2px;
  height: 40px;
}
.splitpanes--horizontal > .splitpanes__splitter::before {
  height: 2px;
  width: 40px;
}
.splitpanes__splitter:hover::before {
  background-color: rgb(34 227 154 / 0.6);
}
</style>
