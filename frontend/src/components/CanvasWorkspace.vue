<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { RecordingSegment } from "../stores/recorder";

const props = defineProps<{
  recordings: RecordingSegment[];
  selectedFileName?: string;
  selectedRecording?: RecordingSegment | null;
  splitView?: boolean;
  // Home / folder drill-down: "Home" lists recording folders as cards; picking one shows just
  // that folder's clips, with the toolbar acting as a Home / <folder> breadcrumb. Off by
  // default so pages that already have their own folder picker (Playback Deck's dropdown) keep
  // the flat clip list this component always showed.
  enableFolderBrowsing?: boolean;
}>();

const emit = defineEmits<{
  select: [fileName: string];
}>();

type FolderSummary = {
  name: string;
  clipCount: number;
  totalSize: number;
  latestCreatedAt: string;
  thumbnailUrl: string;
};

const browsingFolder = ref<string | null>(null);

// Reset to Home if the browsed folder disappears from the recordings list (e.g. it was
// removed, or the recordings prop was swapped out from under us).
watch(() => props.recordings, (recordings) => {
  if (browsingFolder.value && !recordings.some((recording) => recording.sessionFolder === browsingFolder.value)) {
    browsingFolder.value = null;
  }
});

const folders = computed<FolderSummary[]>(() => {
  const byFolder = new Map<string, FolderSummary>();

  for (const recording of props.recordings) {
    const existing = byFolder.get(recording.sessionFolder);

    if (!existing) {
      byFolder.set(recording.sessionFolder, {
        name: recording.sessionFolder,
        clipCount: 1,
        totalSize: recording.size,
        latestCreatedAt: recording.createdAt,
        thumbnailUrl: recording.thumbnailUrl,
      });
      continue;
    }

    existing.clipCount += 1;
    existing.totalSize += recording.size;
    if (new Date(recording.createdAt) > new Date(existing.latestCreatedAt)) {
      existing.latestCreatedAt = recording.createdAt;
      existing.thumbnailUrl = recording.thumbnailUrl;
    }
  }

  return Array.from(byFolder.values()).sort((a, b) => new Date(b.latestCreatedAt).getTime() - new Date(a.latestCreatedAt).getTime());
});

// Flat clip list actually shown below the toolbar — the current folder's clips when browsing
// folders, otherwise every recording (unchanged behavior for pages that don't opt in).
const displayedRecordings = computed(() => {
  if (!props.enableFolderBrowsing) return props.recordings;
  if (!browsingFolder.value) return [];
  return props.recordings.filter((recording) => recording.sessionFolder === browsingFolder.value);
});

function openFolder(name: string) {
  browsingFolder.value = name;

  const firstClip = props.recordings.find((recording) => recording.sessionFolder === name);
  if (firstClip) emit("select", firstClip.fileName);
}

function goHome() {
  browsingFolder.value = null;
}

function formatSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function formatCreatedAt(createdAt: string) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

// No real thumbnail yet (still generating, or generation failed) — blank instead of a
// placeholder graphic. visibility (not display) so the box keeps its reserved space.
function blankOnError(event: Event) {
  (event.target as HTMLImageElement).style.visibility = "hidden";
}

const selectedRecording = computed(() => {
  return props.selectedRecording
    || props.recordings.find((recording) => recording.fileName === props.selectedFileName)
    || props.recordings[0]
    || null;
});
</script>

<template>
  <section class="media-browser">
    <div class="media-toolbar" aria-label="Folders">
      <template v-if="enableFolderBrowsing">
        <button type="button" class="crumb" :class="{ active: !browsingFolder }" @click="goHome">Home</button>
        <template v-if="browsingFolder">
          <span class="crumb-sep" aria-hidden="true">/</span>
          <span class="crumb active">{{ browsingFolder }}</span>
        </template>
      </template>
      <span v-else class="crumb active">{{ selectedRecording?.sessionFolder || "--" }}</span>
    </div>

    <p v-if="enableFolderBrowsing && !browsingFolder && !folders.length" class="empty-browser">
      Recorded Emerald sessions will appear here after the first segment is saved.
    </p>

    <div v-else-if="enableFolderBrowsing && !browsingFolder" class="clip-strip">
      <article
        v-for="folder in folders"
        :key="folder.name"
        class="clip-card"
        @click="openFolder(folder.name)"
      >
        <img :src="folder.thumbnailUrl" :alt="folder.name" @error="blankOnError" />
        <h3>{{ folder.name }}</h3>
        <p>{{ folder.clipCount }} clip{{ folder.clipCount === 1 ? "" : "s" }} &middot; {{ formatSize(folder.totalSize) }}</p>
      </article>
    </div>

    <p v-else-if="!displayedRecordings.length" class="empty-browser">
      Recorded Emerald chunks will appear here after the first segment is saved.
    </p>

    <div v-else-if="!splitView" class="clip-strip">
      <article
        v-for="recording in displayedRecordings"
        :key="recording.fileName"
        class="clip-card"
        :class="{ selected: recording.fileName === selectedFileName }"
        @click="emit('select', recording.fileName)"
      >
        <img :src="recording.thumbnailUrl" :alt="recording.fileName" @error="blankOnError" />
        <h3>{{ recording.fileName }}</h3>
        <p>{{ formatSize(recording.size) }} | {{ formatCreatedAt(recording.createdAt) }}</p>
      </article>
    </div>

    <div v-else class="clip-browser-split">
      <div class="clip-strip clip-strip-split">
        <article
          v-for="recording in displayedRecordings"
          :key="recording.fileName"
          class="clip-card"
          :class="{ selected: recording.fileName === selectedFileName }"
          @click="emit('select', recording.fileName)"
        >
          <img :src="recording.thumbnailUrl" :alt="recording.fileName" @error="blankOnError" />
          <h3>{{ recording.fileName }}</h3>
          <p>{{ formatSize(recording.size) }} | {{ formatCreatedAt(recording.createdAt) }}</p>
        </article>
      </div>

      <aside class="clip-meta-panel" aria-label="Clip metadata">
        <div class="clip-meta-preview">
          <img
            v-if="selectedRecording?.thumbnailUrl"
            :src="selectedRecording.thumbnailUrl"
            :alt="selectedRecording.fileName"
            @error="blankOnError"
          />
        </div>
        <dl class="clip-meta-list">
          <div>
            <dt>File</dt>
            <dd>{{ selectedRecording?.fileName || "--" }}</dd>
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
