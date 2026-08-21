<script setup lang="ts">
/**
 * Application settings route: appearance, editing defaults, and
 * playback preferences backed by settingsStore.
 */
import { useSettingsStore } from '@/stores/settingsStore';

const settingsStore = useSettingsStore();
</script>

<template>
  <div class="mx-auto h-full max-w-2xl overflow-y-auto p-6">
    <h1 class="mb-6 text-xl font-semibold text-slate-100">Settings</h1>

    <section class="mb-6 rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">Appearance</h2>
      <div class="flex items-center justify-between py-2">
        <span class="text-sm text-slate-300">Accent Color</span>
        <div class="flex gap-2">
          <button
            class="h-7 w-7 rounded-full border-2 bg-emerald-400"
            :class="settingsStore.accentColor === 'emerald' ? 'border-white' : 'border-transparent'"
            @click="settingsStore.setAccentColor('emerald')"
          />
          <button
            class="h-7 w-7 rounded-full border-2 bg-teal-400"
            :class="settingsStore.accentColor === 'teal' ? 'border-white' : 'border-transparent'"
            @click="settingsStore.setAccentColor('teal')"
          />
        </div>
      </div>
    </section>

    <section class="mb-6 rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">Editing Defaults</h2>

      <div class="flex items-center justify-between py-2">
        <span class="text-sm text-slate-300">Snap to Frame</span>
        <button
          class="h-6 w-11 rounded-full transition"
          :class="settingsStore.snapToFrame ? 'bg-emerald-500' : 'bg-white/10'"
          @click="settingsStore.toggleSnapToFrame()"
        >
          <span class="block h-5 w-5 translate-x-0.5 rounded-full bg-white transition" :class="settingsStore.snapToFrame ? 'translate-x-[1.375rem]' : ''" />
        </button>
      </div>

      <div class="flex items-center justify-between py-2">
        <span class="text-sm text-slate-300">Auto Save</span>
        <button
          class="h-6 w-11 rounded-full transition"
          :class="settingsStore.autoSave ? 'bg-emerald-500' : 'bg-white/10'"
          @click="settingsStore.toggleAutoSave()"
        >
          <span class="block h-5 w-5 translate-x-0.5 rounded-full bg-white transition" :class="settingsStore.autoSave ? 'translate-x-[1.375rem]' : ''" />
        </button>
      </div>

      <div class="flex items-center justify-between py-2">
        <span class="text-sm text-slate-300">Show Audio Meters</span>
        <button
          class="h-6 w-11 rounded-full transition"
          :class="settingsStore.showAudioMeters ? 'bg-emerald-500' : 'bg-white/10'"
          @click="settingsStore.toggleAudioMeters()"
        >
          <span class="block h-5 w-5 translate-x-0.5 rounded-full bg-white transition" :class="settingsStore.showAudioMeters ? 'translate-x-[1.375rem]' : ''" />
        </button>
      </div>

      <div class="flex items-center justify-between py-2">
        <span class="text-sm text-slate-300">Default FPS</span>
        <span class="font-mono text-sm text-slate-400">{{ settingsStore.defaultFps }}</span>
      </div>

      <div class="flex items-center justify-between py-2">
        <span class="text-sm text-slate-300">Default Resolution</span>
        <span class="font-mono text-sm text-slate-400">{{ settingsStore.defaultResolution }}</span>
      </div>
    </section>

    <section class="rounded-xl border border-white/5 bg-surface-900/80 p-4 shadow-panel">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">Playback</h2>
      <div class="flex items-center justify-between py-2">
        <span class="text-sm text-slate-300">Proxy Playback</span>
        <button
          class="h-6 w-11 rounded-full transition"
          :class="settingsStore.proxyPlayback ? 'bg-emerald-500' : 'bg-white/10'"
          @click="settingsStore.toggleProxyPlayback()"
        >
          <span class="block h-5 w-5 translate-x-0.5 rounded-full bg-white transition" :class="settingsStore.proxyPlayback ? 'translate-x-[1.375rem]' : ''" />
        </button>
      </div>
    </section>
  </div>
</template>
