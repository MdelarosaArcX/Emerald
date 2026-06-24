<script setup lang="ts">
import mediaStill from "../assets/reference-media.png";

const clips = [
  "Copy_ukraine_russia_dron...",
  "Copy(2)_ukraine_russia_dron...",
  "Copy(3)_ukraine_russia_dron...",
  "Copy(4)_ukraine_russia_dron...",
  "Copy(5)_ukraine_russia_dron...",
];
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

    <div class="clip-strip">
      <article
        v-for="(clip, index) in clips"
        :key="clip"
        class="clip-card"
        :class="{ selected: index === 2 }"
      >
        <img :src="mediaStill" alt="" />
        <h3>{{ clip }}</h3>
        <p>00:02:30:50 | 25.5 DVB-T</p>
      </article>
    </div>
  </section>
</template>
