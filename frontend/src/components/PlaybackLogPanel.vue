<script setup lang="ts">
/**
 * Playback's event console — the Capture page's log tab, for playout.
 *
 * Shows the backend's own playout events (on air, cuts, booked clips) interleaved with a line each
 * time the segment being played changes, so the list reads as a history of what actually went out
 * and when. The segment lines are made client-side; see the playbackLog store for why they are not
 * written to the shared log file.
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { describeDelay, usePlaybackLogStore } from "../stores/playbackLog";

const playbackLog = usePlaybackLogStore();
const scrollRef = ref<HTMLElement | null>(null);
// Only follow the tail when the operator is already at the bottom — otherwise reading back through
// the log would keep yanking them forward every time a segment changes.
const stickToBottom = ref(true);
let refreshHandle: number | null = null;

function handleScroll() {
  const el = scrollRef.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

watch(() => playbackLog.entries.length, async () => {
  if (!stickToBottom.value) return;
  await nextTick();
  const el = scrollRef.value;
  if (el) el.scrollTop = el.scrollHeight;
});

onMounted(async () => {
  await playbackLog.refreshServerEntries();
  refreshHandle = window.setInterval(() => playbackLog.refreshServerEntries(), 3000);
  await nextTick();
  if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
});

onUnmounted(() => {
  if (refreshHandle) window.clearInterval(refreshHandle);
});

function formatTimestamp(timestamp: string | null) {
  if (!timestamp) return "--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
</script>

<template>
  <section class="log-deck">
    <header class="log-header">
      <span class="live-dot"></span>
      <h2>Playback Logs</h2>
      <span class="log-count">{{ playbackLog.entries.length }} events</span>
    </header>

    <div ref="scrollRef" class="log-console" @scroll="handleScroll">
      <p v-if="!playbackLog.entries.length" class="log-empty">Waiting for playback events&hellip;</p>
      <ol v-else class="log-lines">
        <li v-for="entry in playbackLog.entries" :key="`${entry.origin}-${entry.id}`" class="log-line">
          <span class="log-time">{{ formatTimestamp(entry.timestamp) }}</span>
          <!-- The playout timecode the entry describes, which is a different clock from the
               wall-clock stamp beside it: air runs a broadcast delay behind capture. -->
          <span class="log-tc">{{ entry.tc || "--" }}</span>
          <!-- How far behind the generator the video was on this line. Blank for backend entries,
               which record a request rather than a moment of playout. -->
          <span
            class="log-delay"
            :class="{ live: entry.delaySeconds === 0 }"
            :title="entry.delaySeconds === null
              ? 'Not a playout event — no delay applies'
              : `The video was ${describeDelay(entry.delaySeconds)} behind the generator at this point`"
          >{{ entry.delaySeconds === null ? "" : describeDelay(entry.delaySeconds) }}</span>
          <span class="log-level" :class="entry.level">{{ entry.level.toUpperCase() }}</span>
          <span class="log-source">{{ entry.source }}</span>
          <span class="log-message">{{ entry.message }}</span>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.log-deck {
  display: flex;
  flex-direction: column;
}

.log-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 10px;
}

.live-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #35f0b1;
  box-shadow: 0 0 6px rgba(53, 240, 177, 0.8);
  animation: log-live-pulse 1.6s ease-in-out infinite;
}

@keyframes log-live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.log-header h2 {
  margin: 0;
  font-size: 1.02rem;
  font-weight: 500;
  color: #f2f6ff;
}

.log-count {
  margin-left: auto;
  color: rgba(185, 194, 219, 0.62);
  font-size: 0.82rem;
}

.log-console {
  max-height: 380px;
  overflow-y: auto;
  padding: 10px 14px;
  background: #0a0e1a;
  border-radius: 6px;
}

.log-empty {
  margin: 0;
  padding: 8px 0;
  color: rgba(185, 194, 219, 0.5);
  font-family: "Consolas", "SFMono-Regular", Menlo, monospace;
  font-size: 0.86rem;
}

.log-lines {
  display: grid;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* One column wider than the Capture log's: playout entries carry a timecode as well as a stamp. */
.log-line {
  display: grid;
  grid-template-columns: 148px 96px 58px 60px 84px minmax(0, 1fr);
  align-items: baseline;
  gap: 10px;
  padding: 1px 0;
  font-family: "Consolas", "SFMono-Regular", Menlo, monospace;
  font-size: 0.82rem;
  line-height: 1.5;
}

.log-time {
  color: rgba(147, 160, 189, 0.85);
  white-space: nowrap;
}

.log-tc {
  color: #35f0b1;
  white-space: nowrap;
}

/* The lag behind the generator. Amber because a growing delay is the thing worth noticing in a
   playout log; "live" (no delay at all) is the unremarkable case and stays quiet. */
.log-delay {
  color: #ffb238;
  white-space: nowrap;
}

.log-delay.live {
  color: rgba(185, 194, 219, 0.5);
}

.log-level {
  font-weight: 700;
  letter-spacing: 0.03em;
}

.log-level.info { color: #7fb1ff; }
.log-level.warn { color: #ffb238; }
.log-level.error { color: #ff4d57; }

.log-source {
  color: rgba(185, 194, 219, 0.75);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-message {
  min-width: 0;
  color: #d7ddeb;
  overflow-wrap: anywhere;
}

.log-console::-webkit-scrollbar {
  width: 8px;
}

.log-console::-webkit-scrollbar-thumb {
  background: #24365b;
  border-radius: 4px;
}
</style>
