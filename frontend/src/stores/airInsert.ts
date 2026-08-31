import { defineStore } from "pinia";

/**
 * Clips booked into the live transmission — the Playback panel's Clip Insert / Clip Overlay.
 *
 * The transmission is a playlist on disk that TX reads a broadcast delay behind capture (see
 * backend/services/airEdlService.js). That gap is the whole mechanism: material recorded but not
 * yet aired can still be rearranged, so a clip placed at a timecode in that window is spliced into
 * the playlist before the play point reaches it and airs as though it had always been there. Air
 * itself is never interrupted — nothing is switched at the moment of transmission.
 */

export type AirInsertMode = "insert" | "overlay";

export type AirInsert = {
  id: string;
  mode: AirInsertMode;
  /** Wall-clock instant the clip starts airing at. */
  atMs: number;
  durationMs: number;
  name: string;
  sourcePath: string;
  createdAt: string;
};

type AirEdlSnapshot = {
  active: boolean;
  sessionFolder?: string;
  recordingStartedAtMs?: number;
  broadcastDelaySeconds?: number;
  inserts?: AirInsert[];
  remainingDelaySeconds?: number;
  minLeadSeconds?: number;
  airPointMs?: number;
};

export const useAirInsertStore = defineStore("airInsert", {
  state: () => ({
    inserts: [] as AirInsert[],
    active: false,
    minLeadSeconds: 4,
    busy: false,
    message: "",
    error: "",
  }),
  actions: {
    async refresh(): Promise<void> {
      try {
        const response = await fetch("/api/air-edl");
        if (!response.ok) return;
        const data = (await response.json()) as AirEdlSnapshot;
        this.active = Boolean(data.active);
        this.inserts = data.inserts ?? [];
        if (data.minLeadSeconds) this.minLeadSeconds = data.minLeadSeconds;
      } catch {
        // Transient — the panel keeps showing the last known bookings rather than emptying itself.
      }
    },

    /**
     * Books a clip. `atMs` is a wall-clock instant, not an offset: the backend places it against
     * the same clock the recorded material is stamped on, which is what lets an operator type a
     * timecode they can read off the on-screen clock.
     */
    async book(mode: AirInsertMode, atMs: number, sourceUrl: string): Promise<boolean> {
      this.busy = true;
      this.error = "";
      this.message = "";

      try {
        const response = await fetch("/api/air-insert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, atMs, sourceUrl }),
        });
        const result = await response.json();

        if (!response.ok) {
          this.error = result?.message || "Could not book that clip.";
          return false;
        }

        this.inserts = result?.inserts ?? [];
        this.message = mode === "overlay" ? "Clip will overlay the live." : "Clip will interrupt the live.";
        return true;
      } catch (error) {
        this.error = (error as Error).message;
        return false;
      } finally {
        this.busy = false;
      }
    },

    async cancel(id: string): Promise<boolean> {
      this.busy = true;
      this.error = "";

      try {
        const response = await fetch(`/api/air-insert/${encodeURIComponent(id)}`, { method: "DELETE" });
        const result = await response.json();

        if (!response.ok) {
          this.error = result?.message || "Could not pull that clip.";
          return false;
        }

        this.inserts = result?.inserts ?? [];
        this.message = "Clip pulled.";
        return true;
      } catch (error) {
        this.error = (error as Error).message;
        return false;
      } finally {
        this.busy = false;
      }
    },
  },
});
