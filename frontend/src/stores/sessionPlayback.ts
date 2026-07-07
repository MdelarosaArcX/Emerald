import { defineStore } from "pinia";

export type SessionSummary = {
  folder: string;
  createdAt: string;
  segmentCount: number;
  size: number;
  isActive: boolean;
};

export type CuedClip = {
  folder: string;
  fileName: string;
  thumbnailUrl: string;
};

// Survives a page refresh so the operator doesn't lose their selected recording folder
// (and, with it, Push On Air / playback context) every time the page reloads.
const SELECTED_FOLDER_STORAGE_KEY = "emerald.sessionPlayback.selectedFolder";

export const useSessionPlaybackStore = defineStore("sessionPlayback", {
  state: () => ({
    sessions: [] as SessionSummary[],
    selectedFolder: localStorage.getItem(SELECTED_FOLDER_STORAGE_KEY) || "",
    // "On air" is a single staged clip ("Put on Air" in the Media Browser), not a rundown —
    // staging a new one replaces whatever was previously staged. Set directly from whatever
    // clip is selected in the Media Browser (a different store/data source), not looked up
    // from a Playback-owned list.
    cuedClip: null as CuedClip | null,
    isBusy: false,
    message: "",
  }),
  actions: {
    async loadSessions() {
      this.sessions = await api<SessionSummary[]>("/api/recording-sessions");

      if (this.selectedFolder && !this.sessions.some((session) => session.folder === this.selectedFolder)) {
        this.selectedFolder = "";
        localStorage.removeItem(SELECTED_FOLDER_STORAGE_KEY);
      }
    },
    selectFolder(folder: string) {
      if (!folder || folder === this.selectedFolder) return;

      this.selectedFolder = folder;
      this.message = "";
      localStorage.setItem(SELECTED_FOLDER_STORAGE_KEY, folder);
    },
    // "Put on Air" — stages a clip for transmission without starting TX yet.
    cueClip(clip: CuedClip) {
      this.cuedClip = clip;
    },
    clearCue() {
      this.cuedClip = null;
    },
  },
});

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || "Request failed.");
  }

  return result as T;
}
