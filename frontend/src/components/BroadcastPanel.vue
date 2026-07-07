<script setup lang="ts">
import { watch } from "vue";
import { useBroadcastStore } from "../stores/broadcast";

const broadcast = useBroadcastStore();

watch(
  () => broadcast.settings,
  () => broadcast.saveSettings(),
  { deep: true }
);
</script>

<template>
  <aside class="recording-card">
    <header class="recording-header">
      <span class="radio-dot" :class="{ live: broadcast.isBroadcasting }"></span>
      <h2>Broadcast Configuration</h2>
    </header>

    <div class="config-grid">
      <label class="field-row field-wide">
        <span>Title</span>
        <input v-model="broadcast.settings.title" class="value-input" placeholder="Click to add title" />
      </label>

      <label class="field-row field-wide">
        <span>Description</span>
        <input v-model="broadcast.settings.description" class="value-input" placeholder="Click to add description" />
      </label>

      <label class="field-row">
        <span>Platform</span>
        <select v-model="broadcast.settings.platform" class="compact-select" @change="broadcast.setPlatform(broadcast.settings.platform)">
          <option value="youtube">YouTube</option>
          <option value="facebook">Facebook</option>
          <option value="twitch">Twitch</option>
          <option value="custom">Custom RTMP</option>
        </select>
      </label>

      <label class="field-row">
        <span>Audio Bitrate</span>
        <select v-model="broadcast.settings.audioBitrate" class="compact-select auto-select">
          <option value="320 kbps">Auto detect - 320 kbps</option>
          <option value="256 kbps">Auto detect - 256 kbps</option>
          <option value="128 kbps">Auto detect - 128 kbps</option>
        </select>
      </label>
    </div>

    <div class="recorder-advanced">
      <label class="field-row source-field">
        <span>Destination RTMP URL</span>
        <input
          v-model="broadcast.settings.destinationUrl"
          :disabled="broadcast.settings.platform !== 'custom'"
          placeholder="rtmp://a.rtmp.youtube.com/live2"
        />
      </label>

      <label class="field-row source-field">
        <span>Stream Key</span>
        <input v-model="broadcast.settings.streamKey" type="password" placeholder="Stream key" />
      </label>
    </div>

    <dl class="stats recorder-advanced">
      <div>
        <dt>Broadcast Status</dt>
        <dd>{{ broadcast.isBroadcasting ? "Live" : "Offline" }}</dd>
      </div>
      <div>
        <dt>Destination</dt>
        <dd>{{ broadcast.broadcastStatus?.destinationUrl || "--" }}</dd>
      </div>
      <div>
        <dt>Message</dt>
        <dd>{{ broadcast.message || "--" }}</dd>
      </div>
    </dl>
  </aside>
</template>
