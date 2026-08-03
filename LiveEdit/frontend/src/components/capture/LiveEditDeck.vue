<script setup lang="ts">
/**
 * Live Edit mode left column: a playback preview of the selected clip stacked above the
 * recorded-clips media browser — both shown together (no tabs), resizable. This preview is plain
 * clip playback (NOT the live capture feed); clicking a clip below plays it here.
 */
import ClipPreview from '@/components/capture/ClipPreview.vue';
import ClipBrowser from '@/components/media/ClipBrowser.vue';
import 'splitpanes/dist/splitpanes.css';
import { Pane, Splitpanes } from 'splitpanes';
</script>

<template>
  <Splitpanes horizontal class="h-full">
    <Pane :size="75" :min-size="50">
      <ClipPreview />
    </Pane>
    <!-- Media library kept compact — just the video gallery — so the Browse Media details above
         get the room. Still draggable/resizable, but capped so it can't crowd the details out. -->
    <Pane :size="25" :min-size="15" :max-size="40">
      <ClipBrowser />
    </Pane>
  </Splitpanes>
</template>
