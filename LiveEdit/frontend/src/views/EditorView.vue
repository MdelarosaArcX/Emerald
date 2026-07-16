<script setup lang="ts">
/**
 * The Live Editor route: the primary broadcast-style workspace combining
 * capture preview, program monitor, live playback monitor, inspector,
 * and the multi-track timeline in a resizable split layout.
 */
import CaptureDeck from '@/components/capture/CaptureDeck.vue';
import InspectorPanel from '@/components/inspector/InspectorPanel.vue';
import ProgramMonitor from '@/components/monitor/ProgramMonitor.vue';
import PlaybackMonitor from '@/components/monitor/PlaybackMonitor.vue';
import TimelineEditor from '@/components/timeline/TimelineEditor.vue';
import { useCaptureStore } from '@/stores/captureStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProgramStore } from '@/stores/programStore';
import { useTimelineStore } from '@/stores/timelineStore';
import 'splitpanes/dist/splitpanes.css';
import { Pane, Splitpanes } from 'splitpanes';
import { onMounted, ref, watch } from 'vue';

const timelineStore = useTimelineStore();
const playbackStore = usePlaybackStore();
const captureStore = useCaptureStore();
const programStore = useProgramStore();

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
});
</script>

<template>
  <div class="flex h-full flex-col gap-3 p-3">
    <Splitpanes class="min-h-0 flex-1" horizontal>
      <Pane :size="72">
        <Splitpanes class="h-full">
          <Pane :size="22" :min-size="16">
            <CaptureDeck />
          </Pane>
          <Pane :size="56" :min-size="30">
            <ProgramMonitor />
          </Pane>
          <Pane :size="22" :min-size="16">
            <PlaybackMonitor :inspector-open="inspectorOpen" @toggle-inspector="toggleInspector" />
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
