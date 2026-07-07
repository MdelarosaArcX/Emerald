import { defineStore } from "pinia";

type RtmpOutStatus = {
  isBroadcasting: boolean;
  startedAt: string | null;
  inputUrl: string | null;
  destinationUrl: string | null;
  lastMessage: string | null;
};

type BroadcastSettings = {
  platform: string;
  destinationUrl: string;
  streamKey: string;
  title: string;
  description: string;
  audioBitrate: string;
};

const platformDestinations: Record<string, string> = {
  youtube: "rtmp://a.rtmp.youtube.com/live2",
  facebook: "rtmps://live-api-s.facebook.com:443/rtmp",
  twitch: "rtmp://live.twitch.tv/app",
  custom: "",
};

const defaultSettings: BroadcastSettings = {
  platform: "custom",
  destinationUrl: "",
  streamKey: "",
  title: "Emerald live broadcast",
  description: "Live push-out of the Emerald capture feed.",
  audioBitrate: "128 kbps",
};

export const useBroadcastStore = defineStore("broadcast", {
  state: () => ({
    settings: { ...defaultSettings },
    broadcastStatus: null as RtmpOutStatus | null,
    message: "",
    isBusy: false,
  }),
  getters: {
    isBroadcasting: (state) => Boolean(state.broadcastStatus?.isBroadcasting),
  },
  actions: {
    loadSettings() {
      const saved = localStorage.getItem("emerald.broadcast.settings");
      if (!saved) return;

      try {
        this.settings = { ...defaultSettings, ...JSON.parse(saved) };
      } catch {
        localStorage.removeItem("emerald.broadcast.settings");
      }
    },
    saveSettings() {
      localStorage.setItem("emerald.broadcast.settings", JSON.stringify(this.settings));
    },
    setPlatform(platform: string) {
      this.settings.platform = platform;
      if (platform !== "custom") {
        this.settings.destinationUrl = platformDestinations[platform] ?? "";
      }
    },
    async refresh() {
      this.broadcastStatus = await api<RtmpOutStatus>("/api/rtmp-out/status");
      this.message = this.broadcastStatus.lastMessage || this.message;
    },
    async start(inputUrl: string, ffmpegPath: string) {
      this.isBusy = true;
      this.saveSettings();

      try {
        this.broadcastStatus = await api<RtmpOutStatus>("/api/rtmp-out/start", {
          method: "POST",
          body: {
            inputUrl,
            ffmpegPath,
            destinationUrl: this.settings.destinationUrl,
            streamKey: this.settings.streamKey,
            audioBitrate: this.settings.audioBitrate,
          },
        });
        this.message = "Live broadcast started.";
      } catch (error) {
        this.message = error instanceof Error ? error.message : "Unable to start the live broadcast.";
      } finally {
        this.isBusy = false;
        await this.refresh();
      }
    },
    async stop() {
      this.isBusy = true;

      try {
        this.broadcastStatus = await api<RtmpOutStatus>("/api/rtmp-out/stop", { method: "POST" });
        this.message = "Live broadcast stopped.";
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
