<script setup lang="ts">
/**
 * Center Program monitor — previews the TIMELINE (the edit), not a single source.
 * At the playhead it renders the active video clip's frame (its thumbnail, since the
 * recorded segments aren't browser-playable) with that clip's effects applied — opacity,
 * blur, transform — plus mute state. So cuts, trims, effect toggles and opacity/scale
 * changes are all reflected live, and Play advances the playhead through the sequence.
 */
import AudioMeter from '@/components/monitor/AudioMeter.vue';
import TransportControls from '@/components/monitor/TransportControls.vue';
import { useTimelineStore } from '@/stores/timelineStore';
import { computed, onBeforeUnmount, ref } from 'vue';

const timelineStore = useTimelineStore();

const frameRef = ref<HTMLElement | null>(null);
const volume = ref(100);
const speed = ref(1);
const speedOptions = [0.25, 0.5, 1, 1.5, 2];
const isPlaying = ref(false);

const fps = computed(() => timelineStore.fps || 25);

const timecode = computed(() => {
  const f = Math.max(1, Math.round(fps.value));
  const total = Math.max(0, Math.round(timelineStore.playhead));
  const ff = total % f;
  const secs = Math.floor(total / f);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(ff)}`;
});

/** Active video clip under the playhead — the topmost visible non-audio track that has one. */
const active = computed(() => {
  const frame = timelineStore.playhead;
  for (const t of timelineStore.tracks) {
    if (t.kind === 'audio' || !t.visible) continue;
    const clip = t.clips.find((c) => frame >= c.start && frame < c.start + c.duration);
    if (clip) return { clip, track: t };
  }
  return null;
});
const hasClip = computed(() => timelineStore.tracks.some((t) => t.clips.length > 0));
const activeEffects = computed(() => active.value?.clip.effects.filter((e) => e.enabled).map((e) => e.name) ?? []);

const previewStyle = computed(() => {
  const a = active.value;
  if (!a) return {} as Record<string, string>;
  const c = a.clip;
  const filters: string[] = [];
  for (const e of c.effects) {
    if (!e.enabled) continue;
    const n = e.name.toLowerCase();
    if (n.includes('blur')) filters.push('blur(5px)');
    if (n.includes('noise')) filters.push('saturate(1.15)');
  }
  return {
    backgroundImage: c.thumbnail ? `url(${c.thumbnail})` : 'none',
    opacity: String(Math.max(0, Math.min(1, (c.opacity ?? 100) / 100))),
    filter: filters.length ? filters.join(' ') : 'none',
    transform: `scale(${(c.scale ?? 100) / 100}) rotate(${c.rotation ?? 0}deg)`,
  };
});

const activeMuted = computed(() => {
  const a = active.value;
  if (!a) return false;
  const audioMuted = timelineStore.tracks.some((t) => t.kind === 'audio' && t.muted);
  return audioMuted || a.clip.effects.some((e) => e.enabled && e.name.toLowerCase().includes('mute'));
});
const meterLevel = computed(() => (isPlaying.value && !activeMuted.value ? volume.value : 0));

// --- Playback loop: advance the playhead through the sequence so cuts play through ---
let rafId = 0;
let lastTs = 0;
let pos = 0;
function loop(ts: number): void {
  if (!isPlaying.value) return;
  if (!lastTs) lastTs = ts;
  pos += ((ts - lastTs) / 1000) * fps.value * speed.value;
  lastTs = ts;
  if (pos >= timelineStore.duration) {
    timelineStore.setPlayhead(timelineStore.duration, false);
    pause();
    return;
  }
  timelineStore.setPlayhead(Math.round(pos), false);
  rafId = requestAnimationFrame(loop);
}
function play(): void {
  if (isPlaying.value || timelineStore.duration <= 0) return;
  pos = timelineStore.playhead >= timelineStore.duration ? 0 : timelineStore.playhead;
  isPlaying.value = true;
  lastTs = 0;
  rafId = requestAnimationFrame(loop);
}
function pause(): void {
  isPlaying.value = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}
function stop(): void {
  pause();
  timelineStore.setPlayhead(0, false);
}
function stepFrame(delta: number): void {
  pause();
  timelineStore.setPlayhead(timelineStore.playhead + delta, false);
}
function jumpSeconds(seconds: number): void {
  pause();
  timelineStore.setPlayhead(timelineStore.playhead + Math.round(seconds * fps.value), false);
}
function handleFullscreen(): void {
  frameRef.value?.requestFullscreen?.();
}
function setVolume(value: number): void {
  volume.value = value;
}
function setSpeed(value: number): void {
  speed.value = value;
}

onBeforeUnmount(pause);
</script>

<template>
  <section class="flex h-full flex-col gap-2.5 rounded-xl border border-white/5 bg-surface-900/80 p-3 shadow-panel">
    <header class="relative flex items-center justify-center">
      <h2 class="absolute left-0 max-w-[40%] truncate pr-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
        {{ active ? active.clip.name : 'Program' }}
      </h2>
      <div class="font-mono text-3xl font-semibold tracking-widest text-slate-100" style="text-shadow: 0 0 18px rgba(23,228,219,0.35)">
        {{ timecode }}
      </div>
      <span class="absolute right-0 text-[10px] uppercase tracking-widest text-slate-500">{{ fps.toFixed(2) }} fps</span>
    </header>

    <div class="relative flex min-h-0 flex-1 items-stretch gap-2 overflow-hidden rounded-lg border border-white/5 bg-black">
      <!-- Left VU meter -->
      <div class="flex w-9 shrink-0 flex-col items-center border-r border-white/5 bg-surface-900/60 py-3">
        <AudioMeter class="flex-1" :level="meterLevel" />
        <div class="mt-1 flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>3</span><span>3</span><span>3</span><span>3</span></div>
        <div class="flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>dB</span><span>dB</span></div>
      </div>

      <!-- Program preview surface (timeline-driven) -->
      <div ref="frameRef" class="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black">
        <div v-if="active" class="absolute inset-0 bg-contain bg-center bg-no-repeat transition-[opacity,filter] duration-150" :style="previewStyle" />
        <div v-else class="pointer-events-none absolute inset-0 flex items-center justify-center bg-grid-fade px-6 text-center text-xs text-slate-600">
          {{ hasClip ? 'No clip under the playhead — move it over a clip to preview' : 'Load or drag a clip onto the timeline to preview it here' }}
        </div>

        <!-- Effect / state overlays -->
        <div v-if="active && activeEffects.length" class="pointer-events-none absolute left-2 top-2 flex max-w-[70%] flex-wrap gap-1">
          <span v-for="fx in activeEffects" :key="fx" class="rounded bg-emerald-500/25 px-1.5 py-0.5 text-[9px] font-medium text-emerald-200 backdrop-blur">{{ fx }}</span>
        </div>
        <div v-if="active" class="pointer-events-none absolute right-2 top-2 flex items-center gap-1">
          <span v-if="(active.clip.opacity ?? 100) < 100" class="rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-slate-200 backdrop-blur">Opacity {{ active.clip.opacity }}%</span>
          <span v-if="activeMuted" class="rounded bg-rose-500/25 px-1.5 py-0.5 text-[9px] font-medium text-rose-300 backdrop-blur">MUTED</span>
        </div>
      </div>

      <!-- Right VU meter -->
      <div class="flex w-9 shrink-0 flex-col items-center border-l border-white/5 bg-surface-900/60 py-3">
        <AudioMeter class="flex-1" :level="meterLevel" />
        <div class="mt-1 flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>3</span><span>3</span><span>3</span><span>3</span></div>
        <div class="flex gap-[3px] font-mono text-[7px] leading-none text-slate-600"><span>dB</span><span>dB</span></div>
      </div>
    </div>

    <TransportControls
      :is-playing="isPlaying"
      :volume="volume"
      :speed="speed"
      :speed-options="speedOptions"
      @play="play"
      @pause="pause"
      @stop="stop"
      @prev-frame="stepFrame(-1)"
      @next-frame="stepFrame(1)"
      @jump-back="jumpSeconds(-10)"
      @jump-forward="jumpSeconds(10)"
      @fullscreen="handleFullscreen"
      @update:volume="setVolume($event)"
      @update:speed="setSpeed($event)"
    />
  </section>
</template>
