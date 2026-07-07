import { defineStore } from "pinia";

type TxStatus = {
  isTransmitting: boolean;
  startedAt: string | null;
  sourceUrl: string | null;
  lastMessage: string | null;
  framesSent: number;
  framesDropped: number;
  lastFrameAt: string | null;
  channelIndex: number;
};

export const useTxStore = defineStore("tx", {
  state: () => ({
    status: null as TxStatus | null,
    isBusy: false,
    message: "",
  }),
  getters: {
    isTransmitting: (state) => Boolean(state.status?.isTransmitting),
    // TX7 is a hardware SDI output with no way to render it back in-browser — this is the
    // closest thing to "is it actually working": frames should land at least every couple
    // seconds while live, so a stale/missing lastFrameAt means the feed has stalled.
    isStalled: (state) => {
      if (!state.status?.isTransmitting) return false;
      if (!state.status.lastFrameAt) return true;
      return Date.now() - new Date(state.status.lastFrameAt).getTime() > 3000;
    },
  },
  actions: {
    async refresh() {
      try {
        this.status = await api<TxStatus>("/api/tx/status");
        this.message = this.status.lastMessage || this.message;
      } catch {
        // Push On Air is optional infrastructure (DeltacastCaptureService may not be running) —
        // a failed status poll shouldn't surface as a page-breaking error.
      }
    },
    async start(folder: string, fileName?: string) {
      this.isBusy = true;

      try {
        this.status = await api<TxStatus>("/api/tx/start", { method: "POST", body: { folder, fileName } });
        this.message = "Pushed on air.";
      } catch (error) {
        this.message = error instanceof Error ? error.message : "Unable to push on air.";
      } finally {
        this.isBusy = false;
        await this.refresh();
      }
    },
    async stop() {
      this.isBusy = true;

      try {
        this.status = await api<TxStatus>("/api/tx/stop", { method: "POST" });
        this.message = "Taken off air.";
      } finally {
        this.isBusy = false;
        await this.refresh();
      }
    },
  },
});

async function api<T>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || "Request failed.");
  }

  return result as T;
}
