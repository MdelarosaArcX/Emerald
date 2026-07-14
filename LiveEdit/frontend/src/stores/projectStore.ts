import { api } from '@/services/api';
import type { MediaAsset, Project, SystemStatus } from '@/types/project';
import { defineStore } from 'pinia';

interface ProjectState {
  project: Project | null;
  status: SystemStatus;
  loading: boolean;
  error: string | null;
}

export const useProjectStore = defineStore('project', {
  state: (): ProjectState => ({
    project: null,
    status: {
      connected: false,
      recording: false,
      playing: false,
      cpuUsage: 0,
      memoryUsage: 0,
      fps: 0,
      networkQuality: 'offline',
      delayMs: 0,
    },
    loading: false,
    error: null,
  }),

  getters: {
    mediaAssets(state): MediaAsset[] {
      return state.project?.mediaAssets ?? [];
    },
    projectName(state): string {
      return state.project?.name ?? 'Emerald Live Edit';
    },
  },

  actions: {
    async fetchProject(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        this.project = await api.getProject();
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Failed to load project';
      } finally {
        this.loading = false;
      }
    },

    async fetchStatus(): Promise<void> {
      try {
        this.status = await api.getStatus();
      } catch {
        this.status.connected = false;
      }
    },

    addMediaAsset(asset: MediaAsset): void {
      this.project?.mediaAssets.push(asset);
    },
  },
});
