import { defineStore } from 'pinia';

interface SettingsState {
  theme: 'dark' | 'darker';
  accentColor: 'emerald' | 'teal';
  autoSave: boolean;
  snapToFrame: boolean;
  showAudioMeters: boolean;
  defaultFps: number;
  defaultResolution: string;
  proxyPlayback: boolean;
  // When on, the editor drops the tabbed left deck for a stacked capture-preview + media-browser
  // column and swaps the right monitor for the video/audio effects panel.
  liveEditMode: boolean;
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({
    theme: 'dark',
    accentColor: 'emerald',
    autoSave: true,
    snapToFrame: true,
    showAudioMeters: true,
    defaultFps: 29.97,
    defaultResolution: '1920x1080',
    proxyPlayback: false,
    liveEditMode: false,
  }),

  actions: {
    toggleLiveEditMode(): void {
      this.liveEditMode = !this.liveEditMode;
    },
    setAccentColor(color: 'emerald' | 'teal'): void {
      this.accentColor = color;
    },
    toggleAutoSave(): void {
      this.autoSave = !this.autoSave;
    },
    toggleSnapToFrame(): void {
      this.snapToFrame = !this.snapToFrame;
    },
    toggleAudioMeters(): void {
      this.showAudioMeters = !this.showAudioMeters;
    },
    toggleProxyPlayback(): void {
      this.proxyPlayback = !this.proxyPlayback;
    },
  },
});
