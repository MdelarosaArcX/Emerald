<script setup lang="ts">
/**
 * Books a clip into the live transmission at a timecode, in one of two modes.
 *
 * Both work the same way underneath — the clip is spliced into the playlist TX is reading, inside
 * the broadcast delay, before the play point gets there. What differs is what happens to the live
 * material at that instant:
 *
 *   Insert  — the live stops, the clip plays in full, and the live resumes from exactly where it
 *             stopped. Nothing is lost; the transmission runs the clip's length longer.
 *   Overlay — the clip plays over the top and the live keeps running underneath, so what was
 *             captured during the clip never airs and the programme rejoins where it would have
 *             been anyway.
 *
 * The timecode is typed as HH:MM:SS:FF against the same clock the deck's on-screen readout shows,
 * so an operator can read a moment off the preview and book against it directly.
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useAirInsertStore, type AirInsertMode } from "../stores/airInsert";
import { useRecorderStore } from "../stores/recorder";

const props = defineProps<{
  /** Generator frame rate, so a typed frame number means the same thing here as on the clock. */
  fps: number;
  /** Where air currently is, as milliseconds since midnight — for the "too close" hint. */
  airPointMsSinceMidnight: number | null;
}>();

const airInsert = useAirInsertStore();
const recorder = useRecorderStore();

const mode = ref<AirInsertMode>("insert");
const timecode = ref("");
const selectedUrl = ref("");
const refreshHandle = ref<number | null>(null);

/** Only browser-playable recordings are offered — the ProRes masters are not valid TX sources. */
const availableClips = computed(() =>
  recorder.recordings.filter((recording) => !/\.mov$/i.test(recording.fileName)),
);

const parsedTimecode = computed(() => parseTimecode(timecode.value, props.fps));

/**
 * Turned into a wall-clock instant against today's midnight, matching how the backend reads it.
 * A timecode that has already passed today is taken as today's — booking into the past is refused
 * by the air-point guard rather than silently rolled forward to tomorrow.
 */
const bookAtMs = computed(() => {
  if (parsedTimecode.value === null) return null;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() + parsedTimecode.value;
});

const tooClose = computed(() => {
  if (parsedTimecode.value === null || props.airPointMsSinceMidnight === null) return false;
  return parsedTimecode.value < props.airPointMsSinceMidnight + airInsert.minLeadSeconds * 1000;
});

const canBook = computed(() =>
  Boolean(selectedUrl.value) && parsedTimecode.value !== null && !tooClose.value && !airInsert.busy,
);

onMounted(async () => {
  await airInsert.refresh();
  refreshHandle.value = window.setInterval(() => airInsert.refresh(), 5000);
});

onUnmounted(() => {
  if (refreshHandle.value) window.clearInterval(refreshHandle.value);
});

async function book() {
  if (!canBook.value || bookAtMs.value === null) return;
  const booked = await airInsert.book(mode.value, bookAtMs.value, selectedUrl.value);
  if (booked) timecode.value = "";
}

/** HH:MM:SS:FF to milliseconds since midnight. Null for anything that is not a full timecode. */
function parseTimecode(value: string, fps: number): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, frames] = match.map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59 || frames >= Math.max(1, fps)) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + (frames / Math.max(1, fps)) * 1000;
}

function formatAt(atMs: number): string {
  const date = new Date(atMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  const frames = Math.floor((date.getMilliseconds() / 1000) * Math.max(1, props.fps));
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(frames)}`;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
</script>

<template>
  <section class="clip-insert" aria-label="Clip insert">
    <header class="clip-insert-head">
      <h3>Clip Insert</h3>
      <span v-if="!airInsert.active" class="clip-insert-idle">Recording required</span>
    </header>

    <div class="config-grid">
      <label class="field-row field-wide" title="Insert stops the live and resumes it after the clip. Overlay plays over the live, which keeps running underneath.">
        <span>Mode</span>
        <select v-model="mode" class="compact-select auto-select" :disabled="!airInsert.active">
          <option value="insert">Insert — cut live, play clip, resume</option>
          <option value="overlay">Overlay — cover live, do not resume</option>
        </select>
      </label>

      <label class="field-row field-wide" title="Which clip to air.">
        <span>Clip</span>
        <select v-model="selectedUrl" class="compact-select auto-select" :disabled="!airInsert.active">
          <option value="" disabled>Select a clip...</option>
          <option v-for="clip in availableClips" :key="clip.url" :value="clip.url">
            {{ clip.sessionFolder }}/{{ clip.fileName }}
          </option>
        </select>
      </label>

      <label class="field-row field-wide" title="Timecode the clip starts airing at, on the generator's clock.">
        <span>At timecode</span>
        <input
          v-model="timecode"
          class="compact-input"
          style="width: 9em"
          placeholder="HH:MM:SS:FF"
          :disabled="!airInsert.active"
        />
      </label>

      <p v-if="timecode && parsedTimecode === null" class="hardware-note warn">
        Type a full timecode as HH:MM:SS:FF — frames run 00 to {{ Math.max(0, fps - 1) }}.
      </p>
      <p v-else-if="tooClose" class="hardware-note warn">
        That is already on air or within {{ airInsert.minLeadSeconds }}s of it. Choose a later timecode.
      </p>
      <p v-else-if="airInsert.error" class="hardware-note warn">{{ airInsert.error }}</p>
      <p v-else-if="airInsert.message" class="hardware-note">{{ airInsert.message }}</p>
    </div>

    <div class="actions">
      <button type="button" :disabled="!canBook" @click="book">
        {{ mode === "overlay" ? "Overlay on Air" : "Insert into Air" }}
      </button>
    </div>

    <div v-if="airInsert.inserts.length" class="booked-clips">
      <h4>Booked</h4>
      <div v-for="entry in airInsert.inserts" :key="entry.id" class="booked-clip">
        <span class="booked-tc">{{ formatAt(entry.atMs) }}</span>
        <span class="booked-name" :title="entry.name">{{ entry.name }}</span>
        <span class="booked-mode">{{ entry.mode === "overlay" ? "overlay" : "insert" }} · {{ formatDuration(entry.durationMs) }}</span>
        <button type="button" class="secondary" :disabled="airInsert.busy" @click="airInsert.cancel(entry.id)">
          Pull
        </button>
      </div>
    </div>
  </section>
</template>
