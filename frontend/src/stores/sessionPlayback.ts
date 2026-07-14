import { defineStore } from "pinia";
import { useTxStore } from "./tx";

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
// Tidal Lock lives on the store (not component state) so it stays engaged across page
// navigation — SessionPlaybackDeck may unmount when you switch pages, but this Pinia store is
// an app-wide singleton that doesn't. Persisted too, so a page refresh doesn't silently turn it
// off (and desync the UI from TX, which keeps transmitting regardless of what the frontend
// thinks) either.
const TIDAL_LOCK_STORAGE_KEY = "emerald.sessionPlayback.tidalLockEnabled";

export const useSessionPlaybackStore = defineStore("sessionPlayback", {
  state: () => ({
    sessions: [] as SessionSummary[],
    selectedFolder: localStorage.getItem(SELECTED_FOLDER_STORAGE_KEY) || "",
    // "On air" is a single staged clip ("Put on Air" in the Media Browser), not a rundown —
    // staging a new one replaces whatever was previously staged. Set directly from whatever
    // clip is selected in the Media Browser (a different store/data source), not looked up
    // from a Playback-owned list.
    cuedClip: null as CuedClip | null,
    tidalLockEnabled: localStorage.getItem(TIDAL_LOCK_STORAGE_KEY) === "1",
    tidalLockedFolder: null as string | null,
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
    toggleTidalLock() {
      this.tidalLockEnabled = !this.tidalLockEnabled;
      localStorage.setItem(TIDAL_LOCK_STORAGE_KEY, this.tidalLockEnabled ? "1" : "0");

      if (this.tidalLockEnabled) {
        this.applyTidalLock();
      } else {
        this.tidalLockedFolder = null;
      }
    },
    // Tidal Lock: once engaged, keeps TX permanently pointed at whatever recording is
    // currently active — no manual folder pick or Push On Air needed. Callers re-run this on
    // every status poll so it follows a recording as it starts, switches to a new one once the
    // old one finishes and a new session starts recording, and takes TX off air automatically
    // once nothing is recording.
    async applyTidalLock() {
      const tx = useTxStore();
      if (!this.tidalLockEnabled || tx.isBusy) return;

      const active = this.sessions.find((session) => session.isActive);

      if (!active) {
        this.tidalLockedFolder = null;
        if (tx.isTransmitting) {
          await tx.stop();
        }
        return;
      }

      if (this.selectedFolder !== active.folder) {
        this.selectFolder(active.folder);
      }

      // TX might already be correctly on air for this exact folder — either because we started
      // it ourselves earlier (tidalLockedFolder already matches), or because Tidal Lock just
      // re-engaged after a page refresh and TX (a separate always-running hardware process)
      // never actually stopped. tidalLockedFolder itself isn't persisted across a refresh, so
      // without the sourceUrl check below every refresh would otherwise stop and immediately
      // restart an already-correct feed, causing a needless on-air blip.
      if (tx.isTransmitting && (this.tidalLockedFolder === active.folder || tx.status?.sourceUrl?.includes(active.folder))) {
        this.tidalLockedFolder = active.folder;
        return;
      }

      if (tx.isTransmitting) {
        await tx.stop();
      }

      this.tidalLockedFolder = active.folder;
      await tx.start(active.folder);
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
