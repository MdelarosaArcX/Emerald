<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useLogsStore } from "../stores/logs";
import { useRecorderStore } from "../stores/recorder";

const logs = useLogsStore();
const recorder = useRecorderStore();
const scrollRef = ref<HTMLElement | null>(null);
// Only auto-scroll to the newest entry if the operator was already at (or near) the bottom —
// otherwise a live tail would keep yanking them back down while they're reading older lines.
const stickToBottom = ref(true);
let refreshHandle: number | null = null;

// Don't fetch/show anything until a recording is actually happening — otherwise this would open
// showing stale history from whatever unrelated session last wrote to logs.txt. Once true it
// stays true, so the panel keeps showing this session's events (including its own "Recording
// stopped" line) after recording ends, instead of yanking back to empty the moment it stops.
const hasStartedRecording = ref(recorder.isRecording);

function startPolling() {
  if (refreshHandle) return;
  logs.refresh();
  refreshHandle = window.setInterval(() => logs.refresh(), 3000);
}

watch(
  () => recorder.isRecording,
  (isRecording) => {
    if (isRecording && !hasStartedRecording.value) {
      hasStartedRecording.value = true;
    }
  },
);

watch(hasStartedRecording, async (started) => {
  if (!started) return;
  startPolling();
  await nextTick();
  if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
});

function handleScroll() {
  const el = scrollRef.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function formatTimestamp(timestamp: string | null) {
  if (!timestamp) return "--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

watch(() => logs.entries.length, async () => {
  if (!stickToBottom.value) return;
  await nextTick();
  const el = scrollRef.value;
  if (el) el.scrollTop = el.scrollHeight;
});

onMounted(() => {
  if (hasStartedRecording.value) startPolling();
});

onUnmounted(() => {
  if (refreshHandle) window.clearInterval(refreshHandle);
});
</script>

<template>
  <section class="log-deck">
    <header class="log-header">
      <span class="live-dot"></span>
      <h2>Capture Logs</h2>
      <span class="log-count">{{ logs.entries.length }} events</span>
    </header>

    <div ref="scrollRef" class="log-console" @scroll="handleScroll">
      <p v-if="!hasStartedRecording" class="log-empty">Waiting for recording to start&hellip;</p>
      <p v-else-if="!logs.entries.length" class="log-empty">Waiting for log events&hellip;</p>
      <ol v-else class="log-lines">
        <li v-for="entry in logs.entries" :key="entry.id" class="log-line">
          <span class="log-time">{{ formatTimestamp(entry.timestamp) }}</span>
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

.log-line {
  display: grid;
  grid-template-columns: 148px 60px 100px minmax(0, 1fr);
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

.log-level {
  font-weight: 700;
  letter-spacing: 0.03em;
}

.log-level.info {
  color: #7fb1ff;
}

.log-level.warn {
  color: #ffb238;
}

.log-level.error {
  color: #ff4d57;
}

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
