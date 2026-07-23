<script setup lang="ts">
/**
 * Live Edit mode left column: the live capture preview stacked above the
 * recorded-clips media browser — both shown together (no tabs), resizable.
 * Selecting a clip loads it into the center Program monitor.
 */
import CapturePreview from '@/components/capture/CapturePreview.vue';
import ClipBrowser from '@/components/media/ClipBrowser.vue';
import 'splitpanes/dist/splitpanes.css';
import { Pane, Splitpanes } from 'splitpanes';
</script>

<template>
  <Splitpanes horizontal class="h-full">
    <Pane :size="63" :min-size="30">
      <CapturePreview />
    </Pane>
    <Pane :size="37" :min-size="22">
      <ClipBrowser />
    </Pane>
  </Splitpanes>
</template>
