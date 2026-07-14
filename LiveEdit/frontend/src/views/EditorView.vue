<script setup lang="ts">
/**
 * The Live Editor route: the primary broadcast-style workspace combining
 * capture preview, program monitor, live playback monitor, inspector,
 * and the multi-track timeline in a resizable split layout.
 */
import CapturePreview from '@/components/capture/CapturePreview.vue';
import InspectorPanel from '@/components/inspector/InspectorPanel.vue';
import ProgramMonitor from '@/components/monitor/ProgramMonitor.vue';
import PlaybackMonitor from '@/components/monitor/PlaybackMonitor.vue';
import TimelineEditor from '@/components/timeline/TimelineEditor.vue';
import { useCaptureStore } from '@/stores/captureStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import 'splitpanes/dist/splitpanes.css';
import { Pane, Splitpanes } from 'splitpanes';
import { onMounted } from 'vue';

const timelineStore = useTimelineStore();
const playbackStore = usePlaybackStore();
const captureStore = useCaptureStore();

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
            <CapturePreview />
          </Pane>
          <Pane :size="56" :min-size="30">
            <ProgramMonitor />
          </Pane>
          <Pane :size="22" :min-size="16">
            <PlaybackMonitor />
          </Pane>
        </Splitpanes>
      </Pane>
      <Pane :size="28" :min-size="15">
        <div class="flex h-full gap-3 pt-3">
          <TimelineEditor class="min-w-0 flex-1" />
          <InspectorPanel />
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
