import { api } from '@/services/api';
import type { MediaAsset, Project, SystemStatus } from '@/types/project';
import { defineStore } from 'pinia';

/** One file's progress through an import, shown in the Media Browser while it uploads. */
export interface MediaImportJob {
  id: string;
  name: string;
  /** 0–1 while uploading; reaches 1 before probing, which has no progress to report. */
  progress: number;
  state: 'uploading' | 'probing' | 'done' | 'failed';
  error?: string;
}

interface ProjectState {
  project: Project | null;
  status: SystemStatus;
  loading: boolean;
  error: string | null;
  imports: MediaImportJob[];
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
    imports: [],
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

    /**
     * Imports files into the project's media library.
     *
     * Sequential rather than concurrent: these are large local uploads, and running them in
     * parallel only splits the same disk and socket bandwidth between them while making the
     * per-file progress meaningless. One at a time finishes the first file soonest, which is the
     * one the operator is most likely waiting to drop onto the timeline.
     *
     * Resolves to the assets that imported successfully. Failures are left on `imports` with their
     * message rather than thrown, so one bad file in a multi-file selection doesn't abandon the
     * rest — the caller gets what worked and the panel shows what didn't.
     */
    async importFiles(files: File[]): Promise<MediaAsset[]> {
      const imported: MediaAsset[] = [];

      for (const file of files) {
        const job: MediaImportJob = {
          // Not the filename: the same file can legitimately be imported twice, and two jobs
          // sharing a key makes Vue reuse one row for both.
          id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          progress: 0,
          state: 'uploading',
        };
        this.imports.push(job);

        try {
          const asset = await api.importMediaFile(file, (fraction) => {
            job.progress = fraction;
            // The upload finishing doesn't mean the import has: the backend still has to ffprobe
            // it, which on a large file is a visible pause. Saying so beats a bar sitting at 100%.
            if (fraction >= 1) job.state = 'probing';
          });

          job.progress = 1;
          job.state = 'done';
          this.addMediaAsset(asset);
          imported.push(asset);

          // Completed rows are noise once the asset is in the grid below them.
          setTimeout(() => {
            this.imports = this.imports.filter((entry) => entry.id !== job.id);
          }, 1500);
        } catch (error) {
          job.state = 'failed';
          job.error = error instanceof Error ? error.message : 'Import failed';
        }
      }

      return imported;
    },

    /** Clears failed import rows once the operator has read them. */
    dismissImport(id: string): void {
      this.imports = this.imports.filter((entry) => entry.id !== id);
    },
  },
});
