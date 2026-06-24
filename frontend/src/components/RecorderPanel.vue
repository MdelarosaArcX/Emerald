<script setup lang="ts">
import { computed } from "vue";
import { useRecorderStore } from "../stores/recorder";

const recorder = useRecorderStore();

const activeStreams = computed(() => recorder.ingestStatus?.activeStreams.join(", ") || "None");
const recordingCount = computed(() => recorder.recordings.length);
</script>

<template>
  <aside class="recording-card">
    <header class="recording-header">
      <span class="radio-dot" :class="{ live: recorder.isRecording }"></span>
      <h2>Recording Configuration</h2>
    </header>

    <div class="config-grid">
      <label class="wide">
        <span>Output path</span>
        <input value="/home/Admin/Videos/political_war/" readonly />
      </label>

      <label class="wide">
        <span>Title</span>
        <input value="russian_responder" />
      </label>

      <label class="wide">
        <span>Description</span>
        <textarea rows="2">Quick responder after tragic drone attack, giving immediate aide to the casualties.</textarea>
      </label>

      <label>
        <span>Set Duration</span>
        <input v-model.number="recorder.settings.segmentSeconds" type="number" min="10" max="3600" />
      </label>

      <label>
        <span>FPS</span>
        <select>
          <option>25 DVB-T</option>
          <option>30 DVB-T</option>
          <option>60 DVB-T</option>
        </select>
      </label>

      <label>
        <span>Format</span>
        <select v-model="recorder.settings.container">
          <option value="mp4">MP4</option>
          <option value="mkv">MKV</option>
          <option value="ts">MPEG-TS</option>
        </select>
      </label>

      <label>
        <span>Video Bitrate</span>
        <select>
          <option>3000 kbps</option>
          <option>5000 kbps</option>
          <option>8000 kbps</option>
        </select>
      </label>

      <label>
        <span>Audio Bitrate</span>
        <select>
          <option>320 kbps</option>
          <option>256 kbps</option>
          <option>128 kbps</option>
        </select>
      </label>

      <label>
        <span>Audio Sample Frequency</span>
        <select>
          <option>96 kHz</option>
          <option>48 kHz</option>
          <option>44.1 kHz</option>
        </select>
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
