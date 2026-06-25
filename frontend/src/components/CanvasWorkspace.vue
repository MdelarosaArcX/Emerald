<script setup lang="ts">
import mediaStill from "../assets/reference-media.png";
import type { RecordingSegment } from "../stores/recorder";

defineProps<{
  recordings: RecordingSegment[];
  selectedFileName?: string;
}>();

const emit = defineEmits<{
  select: [fileName: string];
}>();

function formatSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function formatCreatedAt(createdAt: string) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function useFallbackStill(event: Event) {
  const image = event.target as HTMLImageElement;
  image.src = mediaStill;
}
</script>

<template>
  <section class="media-browser">
    <div class="media-toolbar" aria-label="Folders">
      <span class="crumb">home</span>
      <span class="crumb">Admin</span>
      <span class="crumb">Emerald IP</span>
      <span class="crumb">recording</span>
      <span class="crumb active">062226</span>
      <div class="browser-tools" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>

    <p v-if="!recordings.length" class="empty-browser">
      Recorded OBS chunks will appear here after the first segment is saved.
    </p>

    <div v-else class="clip-strip">
      <article
        v-for="recording in recordings"
        :key="recording.fileName"
        class="clip-card"
        :class="{ selected: recording.fileName === selectedFileName }"
        @click="emit('select', recording.fileName)"
      >
        <img :src="recording.thumbnailUrl" :alt="recording.fileName" @error="useFallbackStill" />
        <h3>{{ recording.fileName }}</h3>
        <p>{{ formatSize(recording.size) }} | {{ formatCreatedAt(recording.createdAt) }}</p>
      </article>
    </div>
  </section>
</template>
