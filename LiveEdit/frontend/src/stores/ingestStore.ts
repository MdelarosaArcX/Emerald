import { defineStore } from 'pinia';

/**
 * Tracks live ingest: the recording session currently being auto-loaded into the timeline. When a
 * live session is loaded, EditorView polls it and appends newly-recorded segments as they arrive.
 */
interface IngestState {
  /** Folder of the session being auto-ingested (null = not live-ingesting). */
  liveFolder: string | null;
  /** Folder currently loaded on the timeline (live or a finished session). */
  loadedFolder: string | null;
  segmentSeconds: number;
  recording: boolean;
}

export const useIngestStore = defineStore('ingest', {
  state: (): IngestState => ({
    liveFolder: null,
    loadedFolder: null,
    segmentSeconds: 120,
    recording: false,
  }),
  actions: {
    startLive(folder: string, segmentSeconds: number): void {
      this.liveFolder = folder;
      this.loadedFolder = folder;
      this.segmentSeconds = segmentSeconds;
      this.recording = true;
    },
    setLoaded(folder: string | null): void {
      this.loadedFolder = folder;
      this.liveFolder = null; // a manual (finished-session) load isn't live
    },
    stopLive(): void {
      this.liveFolder = null;
    },
    setRecording(value: boolean): void {
      this.recording = value;
    },
  },
});
