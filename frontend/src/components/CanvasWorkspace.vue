<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import Konva from "konva";
import { Canvas, Rect, Textbox } from "fabric";

const konvaRoot = ref<HTMLDivElement | null>(null);
const fabricCanvas = ref<HTMLCanvasElement | null>(null);
let konvaStage: Konva.Stage | null = null;
let fabricStage: Canvas | null = null;

onMounted(() => {
  if (konvaRoot.value) {
    konvaStage = new Konva.Stage({
      container: konvaRoot.value,
      width: 440,
      height: 220,
    });
    const layer = new Konva.Layer();
    const rect = new Konva.Rect({
      x: 28,
      y: 36,
      width: 150,
      height: 86,
      fill: "#1f9d8a",
      cornerRadius: 8,
      draggable: true,
    });
    const label = new Konva.Text({
      x: 32,
      y: 146,
      text: "Konva layer",
      fontSize: 18,
      fill: "#17202a",
    });
    layer.add(rect, label);
    konvaStage.add(layer);
  }

  if (fabricCanvas.value) {
    fabricStage = new Canvas(fabricCanvas.value, {
      width: 440,
      height: 220,
      backgroundColor: "#ffffff",
    });
    fabricStage.add(new Rect({
      left: 34,
      top: 36,
      width: 148,
      height: 86,
      fill: "#de6b48",
      rx: 8,
      ry: 8,
    }));
    fabricStage.add(new Textbox("Fabric layer", {
      left: 34,
      top: 146,
      width: 180,
      fontSize: 18,
      fill: "#17202a",
    }));
    fabricStage.renderAll();
  }
});

onUnmounted(() => {
  konvaStage?.destroy();
  fabricStage?.dispose();
});
</script>

<template>
  <section class="canvas-band">
    <div class="canvas-surface">
      <header>
        <h2>Canvas Workspace</h2>
        <span>Konva.js and Fabric.js ready</span>
      </header>
      <div class="canvas-grid">
        <div ref="konvaRoot" class="canvas-box"></div>
        <canvas ref="fabricCanvas" class="canvas-box"></canvas>
      </div>
    </div>
  </section>
</template>
