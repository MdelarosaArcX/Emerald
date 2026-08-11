<script setup lang="ts">
/**
 * Live Edit mode left column: a playback preview of the selected clip (plus its Browse Media
 * details) stacked above the Video Library — both shown together (no tabs), resizable.
 *
 * The top pane is ClipPreview, not CapturePreview: in Live Edit the operator is cutting recorded
 * material, so this column shows the clip being edited rather than the live capture feed. The
 * live feed still has its own panel in the standard (non-Live-Edit) deck.
 */
import ClipPreview from '@/components/capture/ClipPreview.vue';
import ClipBrowser from '@/components/media/ClipBrowser.vue';
import 'splitpanes/dist/splitpanes.css';
import { Pane, Splitpanes } from 'splitpanes';
</script>

<template>
  <Splitpanes horizontal class="h-full">
    <Pane :size="63" :min-size="30">
      <ClipPreview />
    </Pane>
    <!-- Library kept compact but resizable so the Browse Media details above keep their room. -->
    <Pane :size="37" :min-size="22">
      <ClipBrowser />
    </Pane>
  </Splitpanes>
</template>
