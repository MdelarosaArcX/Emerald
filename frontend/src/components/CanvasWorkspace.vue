<script setup lang="ts">
import { computed } from "vue";
import type { RecordingSegment } from "../stores/recorder";

const props = defineProps<{
  recordings: RecordingSegment[];
  selectedFileName?: string;
  selectedRecording?: RecordingSegment | null;
  splitView?: boolean;
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

const selectedRecording = computed(() => {
  return props.selectedRecording
    || props.recordings.find((recording) => recording.fileName === props.selectedFileName)
    || null;
});
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

    <div v-else-if="!splitView" class="clip-strip">
      <article
        v-for="recording in recordings"
        :key="recording.fileName"
        class="clip-card"
        :class="{ selected: recording.fileName === selectedFileName }"
        @click="emit('select', recording.fileName)"
      >
        <img :src="recording.thumbnailUrl" :alt="recording.fileName" />
        <h3>{{ recording.fileName }}</h3>
        <p>{{ recording.timecode }} | {{ formatSize(recording.size) }} | {{ formatCreatedAt(recording.createdAt) }}</p>
      </article>
    </div>

    <div v-else class="clip-browser-split">
      <div class="clip-strip clip-strip-split">
        <article
          v-for="recording in recordings"
          :key="recording.fileName"
          class="clip-card"
          :class="{ selected: recording.fileName === selectedFileName }"
          @click="emit('select', recording.fileName)"
        >
          <img :src="recording.thumbnailUrl" :alt="recording.fileName" />
          <h3>{{ recording.fileName }}</h3>
          <p>{{ recording.timecode }} | {{ formatSize(recording.size) }} | {{ formatCreatedAt(recording.createdAt) }}</p>
        </article>
      </div>

      <aside class="clip-meta-panel" aria-label="Clip metadata">
        <div class="clip-meta-preview">
          <img
            :src="selectedRecording?.thumbnailUrl || ''"
            :alt="selectedRecording?.fileName || 'Selected clip'"
          />
        </div>
        <dl class="clip-meta-list">
          <div>
            <dt>File</dt>
            <dd>{{ selectedRecording?.fileName || "--" }}</dd>
          </div>
          <div>
            <dt>Timecode</dt>
            <dd>{{ selectedRecording?.timecode || "--" }}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{{ selectedRecording ? formatCreatedAt(selectedRecording.createdAt) : "--" }}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{{ selectedRecording ? formatSize(selectedRecording.size) : "--" }}</dd>
          </div>
          <div>
            <dt>URL</dt>
            <dd>{{ selectedRecording?.url || "--" }}</dd>
          </div>
        </dl>
      </aside>
    </div>
  </section>
</template>
