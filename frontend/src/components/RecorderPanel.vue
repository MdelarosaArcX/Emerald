<script setup lang="ts">
import { computed, watch } from "vue";
import { useRecorderStore } from "../stores/recorder";

const recorder = useRecorderStore();

const activeStreams = computed(() => recorder.ingestStatus?.activeStreams.join(", ") || "None");
const recordingCount = computed(() => recorder.recordings.length);

watch(
  () => recorder.settings,
  () => recorder.saveSettings(),
  { deep: true }
);
</script>

<template>
  <aside class="recording-card">
    <header class="recording-header">
      <span class="radio-dot" :class="{ live: recorder.isRecording }"></span>
      <h2>Recording Configuration</h2>
    </header>

    <div class="config-grid">
      <label class="field-row field-wide">
        <span>Output path</span>
        <input v-model="recorder.settings.outputPath" class="value-input" placeholder="Click to browse output path" />
      </label>

      <label class="field-row field-wide">
        <span>Title</span>
        <input v-model="recorder.settings.title" class="value-input" placeholder="Click to add title" />
      </label>

      <label class="field-row field-wide">
        <span>Description</span>
        <input v-model="recorder.settings.description" class="value-input" placeholder="Click to add description" />
      </label>

      <label class="field-row">
        <span>FPS</span>
        <select v-model="recorder.settings.fps" class="compact-select">
          <option value="25">25 DVB-T</option>
          <option value="30">30 DVB-T</option>
          <option value="60">60 DVB-T</option>
        </select>
      </label>

      <label class="field-row field-wide">
        <span>Format</span>
        <span class="format-controls">
          <select v-model="recorder.settings.container" class="compact-select auto-select">
            <option value="mov">MOV</option>
            <option value="mp4">MP4</option>
            <option value="mkv">Auto detect - MKV</option>
            <option value="ts">Auto detect - MPEG-TS</option>
          </select>
          <select v-model="recorder.settings.videoCodec" class="compact-select auto-select">
            <option value="ProRes 422">ProRes 422</option>
            <option value="H.264">Auto detect - H.264</option>
            <option value="H.265">Auto detect - H.265</option>
          </select>
          <select v-model="recorder.settings.audioCodec" class="compact-select auto-select">
            <option value="AAC">Auto detect - AAC</option>
            <option value="Opus">Auto detect - Opus</option>
          </select>
        </span>
      </label>

      <label class="field-row">
        <span>Video Bitrate</span>
        <select v-model="recorder.settings.videoBitrate" class="compact-select auto-select">
          <option value="3000 kbps">Auto detect - 3000 kbps</option>
          <option value="5000 kbps">Auto detect - 5000 kbps</option>
          <option value="8000 kbps">Auto detect - 8000 kbps</option>
        </select>
      </label>

      <label class="field-row">
        <span>Audio Bitrate</span>
        <select v-model="recorder.settings.audioBitrate" class="compact-select auto-select">
          <option value="320 kbps">Auto detect - 320 kbps</option>
          <option value="256 kbps">Auto detect - 256 kbps</option>
          <option value="128 kbps">Auto detect - 128 kbps</option>
        </select>
      </label>

      <label class="field-row">
        <span>Audio Sample Frequency</span>
        <select v-model="recorder.settings.audioSampleFrequency" class="compact-select auto-select">
          <option value="96 kHz">Auto detect - 96 kHz</option>
          <option value="48 kHz">Auto detect - 48 kHz</option>
          <option value="44.1 kHz">Auto detect - 44.1 kHz</option>
        </select>
      </label>
    </div>

    <div class="recorder-advanced">
      <label class="field-row source-field">
        <span>Source URL</span>
        <input v-model="recorder.settings.inputUrl" placeholder="udp://0.0.0.0:5000" />
      </label>

      <label class="field-row">
        <span>FFmpeg Path</span>
        <input v-model="recorder.settings.ffmpegPath" placeholder="ffmpeg or C:\ffmpeg\bin\ffmpeg.exe" />
      </label>
    </div>

    <dl class="stats recorder-advanced">
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

    <ol class="segments recorder-advanced">
      <li v-for="recording in recorder.recordings" :key="recording.fileName">
        <a :href="recording.url" target="_blank" rel="noreferrer">{{ recording.fileName }}</a>
        <span>{{ Math.round(recording.size / 1024) }} KB</span>
      </li>
    </ol>
  </aside>
</template>
