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

// Multi-selection for export, kept separate from `selectedFileName` (which drives the preview
// player). Clicking a card still previews it; the checkbox is what builds an export set, so
// picking clips to join never disturbs what is being watched.
const exportSelection = ref<Set<string>>(new Set());
const exportBusy = ref(false);
const exportError = ref<string | null>(null);
const exportResult = ref<{ fileName: string; url: string; startTimecode: string; clipCount: number } | null>(null);
const showExportDialog = ref(false);
const exportTimecode = ref("");
const exportName = ref("");
const timecodeUnknown = ref(false);

const selectedClips = computed(() =>
  displayedRecordings.value.filter((recording) => exportSelection.value.has(recording.fileName)),
);

function toggleExportSelection(fileName: string) {
  const next = new Set(exportSelection.value);
  if (next.has(fileName)) next.delete(fileName);
  else next.add(fileName);
  exportSelection.value = next;
}

function selectAllForExport() {
  exportSelection.value = new Set(displayedRecordings.value.map((recording) => recording.fileName));
}

function clearExportSelection() {
  exportSelection.value = new Set();
}

// Clips are joined in recording order regardless of the order they were ticked, so the dialog
// prefills from the earliest one — that is the timecode the joined file actually starts at.
function earliestSelected() {
  return [...selectedClips.value].sort((a, b) => a.fileName.localeCompare(b.fileName))[0] || null;
}

async function openExportDialog() {
  const first = earliestSelected();
  if (!first) return;

  exportError.value = null;
  exportResult.value = null;
  timecodeUnknown.value = false;
  exportName.value = "";
  showExportDialog.value = true;

  // Prefilled from what was really stored when that segment was captured, not recomputed here.
  try {
    const query = new URLSearchParams({ sessionFolder: first.sessionFolder, fileName: first.fileName });
    const response = await fetch(`/api/recordings/start-timecode?${query}`);
    const result = await response.json();
    if (response.ok && result.startTimecode) {
      exportTimecode.value = result.startTimecode;
    } else {
      // Nothing recorded for this segment — ask rather than invent a plausible-looking value.
      exportTimecode.value = "";
      timecodeUnknown.value = true;
    }
  } catch {
    exportTimecode.value = "";
    timecodeUnknown.value = true;
  }
}

async function runExport() {
  if (!/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(exportTimecode.value.trim())) {
    exportError.value = "Timecode must be HH:MM:SS:FF.";
    return;
  }

  exportBusy.value = true;
  exportError.value = null;

  try {
    const response = await fetch("/api/recordings/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clips: selectedClips.value.map((recording) => ({
          sessionFolder: recording.sessionFolder,
          fileName: recording.fileName,
        })),
        startTimecode: exportTimecode.value.trim(),
        outputName: exportName.value.trim() || undefined,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Export failed.");

    exportResult.value = result;
    clearExportSelection();
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : String(error);
  } finally {
    exportBusy.value = false;
  }
}

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
  // Selection is scoped to what is on screen — carrying ticks across folders would let an export
  // include clips the operator can no longer see.
  clearExportSelection();

  const firstClip = props.recordings.find((recording) => recording.sessionFolder === name);
  if (firstClip) emit("select", firstClip.fileName);
}

function goHome() {
  browsingFolder.value = null;
  clearExportSelection();
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

      <!-- Export controls. Only meaningful once a folder's clips are on screen, so they stay
           hidden on the folder-cards view where there is nothing tickable. -->
      <span v-if="displayedRecordings.length" class="export-bar">
        <span class="export-count">{{ exportSelection.size }} selected</span>
        <button type="button" class="export-link" @click="selectAllForExport">All</button>
        <button type="button" class="export-link" :disabled="!exportSelection.size" @click="clearExportSelection">None</button>
        <button
          type="button"
          class="export-action"
          :disabled="!exportSelection.size"
          :title="exportSelection.size ? `Join ${exportSelection.size} clip(s) into one timecoded file` : 'Tick clips to export'"
          @click="openExportDialog"
        >Export</button>
      </span>
    </div>

    <!-- Export dialog -->
    <div v-if="showExportDialog" class="export-dialog" role="dialog" aria-label="Export clips">
      <template v-if="!exportResult">
        <h3>Export {{ selectedClips.length }} clip{{ selectedClips.length === 1 ? "" : "s" }}</h3>
        <p class="export-hint">
          Joined in recording order without re-encoding, and stamped with the start timecode below
          so LiveEdit drops it onto the timeline at the right position.
        </p>
        <label class="export-field">
          <span>Start timecode</span>
          <input v-model="exportTimecode" placeholder="HH:MM:SS:FF" inputmode="numeric" />
        </label>
        <p v-if="timecodeUnknown" class="export-warn">
          No stored timecode for the first clip — enter one manually.
        </p>
        <label class="export-field">
          <span>File name</span>
          <input v-model="exportName" placeholder="(auto)" />
        </label>
        <p v-if="exportError" class="export-warn">{{ exportError }}</p>
        <div class="export-buttons">
          <button type="button" class="export-link" :disabled="exportBusy" @click="showExportDialog = false">Cancel</button>
          <button type="button" class="export-action" :disabled="exportBusy" @click="runExport">
            {{ exportBusy ? "Exporting…" : "Export" }}
          </button>
        </div>
      </template>
      <template v-else>
        <h3>Export complete</h3>
        <p class="export-hint">
          {{ exportResult.fileName }} — {{ exportResult.clipCount }} clip(s) starting at
          {{ exportResult.startTimecode }}.
        </p>
        <div class="export-buttons">
          <a class="export-action" :href="exportResult.url" download>Download</a>
          <button type="button" class="export-link" @click="showExportDialog = false">Close</button>
        </div>
      </template>
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
        :class="{ selected: recording.fileName === selectedFileName, ticked: exportSelection.has(recording.fileName) }"
        @click="emit('select', recording.fileName)"
      >
        <input
          class="clip-tick"
          type="checkbox"
          :checked="exportSelection.has(recording.fileName)"
          :aria-label="`Select ${recording.fileName} for export`"
          @click.stop
          @change="toggleExportSelection(recording.fileName)"
        />
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
          :class="{ selected: recording.fileName === selectedFileName, ticked: exportSelection.has(recording.fileName) }"
          @click="emit('select', recording.fileName)"
        >
          <input
            class="clip-tick"
            type="checkbox"
            :checked="exportSelection.has(recording.fileName)"
            :aria-label="`Select ${recording.fileName} for export`"
            @click.stop
            @change="toggleExportSelection(recording.fileName)"
          />
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
