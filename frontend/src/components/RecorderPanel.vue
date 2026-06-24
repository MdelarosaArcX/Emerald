<script setup lang="ts">
import { computed } from "vue";
import { useRecorderStore } from "../stores/recorder";

const recorder = useRecorderStore();

const activeStreams = computed(() => recorder.ingestStatus?.activeStreams.join(", ") || "None");
const recordingCount = computed(() => recorder.recordings.length);
</script>

<template>
  <aside class="panel controls">
    <label>
      <span>OBS Recording URL</span>
      <input v-model="recorder.settings.inputUrl" />
    </label>

    <div class="field-row">
      <label>
        <span>Container</span>
        <select v-model="recorder.settings.container">
          <option value="mp4">MP4</option>
          <option value="mkv">MKV</option>
          <option value="ts">MPEG-TS</option>
        </select>
      </label>

      <label>
        <span>Segment Seconds</span>
        <input v-model.number="recorder.settings.segmentSeconds" type="number" min="10" max="3600" />
      </label>
    </div>

    <label>
      <span>FFmpeg Path</span>
      <input v-model="recorder.settings.ffmpegPath" placeholder="ffmpeg or C:\ffmpeg\bin\ffmpeg.exe" />
    </label>

    <div class="actions">
      <button type="button" :disabled="recorder.isBusy || recorder.isRecording" @click="recorder.start">
        Start
      </button>
      <button type="button" class="secondary" :disabled="recorder.isBusy || !recorder.isRecording" @click="recorder.stop">
        Stop
      </button>
    </div>

    <dl class="stats">
      <div>
        <dt>RTMP Ingest</dt>
        <dd>{{ recorder.ingestStatus?.lastMessage || "--" }}</dd>
      </div>
      <div>
        <dt>Active Streams</dt>
        <dd>{{ activeStreams }}</dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>{{ recorder.recorderStatus?.outputPattern || "--" }}</dd>
      </div>
      <div>
        <dt>Saved Segments</dt>
        <dd>{{ recordingCount }}</dd>
      </div>
      <div>
        <dt>Message</dt>
        <dd>{{ recorder.message || "--" }}</dd>
      </div>
    </dl>

    <ol class="segments">
      <li v-for="recording in recorder.recordings" :key="recording.fileName">
        <a :href="recording.url" target="_blank" rel="noreferrer">{{ recording.fileName }}</a>
        <span>{{ Math.round(recording.size / 1024) }} KB</span>
      </li>
    </ol>
  </aside>
</template>
