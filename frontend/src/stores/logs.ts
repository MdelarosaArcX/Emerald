import { defineStore } from "pinia";

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  id: number;
  timestamp: string | null;
  level: LogLevel;
  tc: string | null;
  source: string;
  message: string;
};

export const useLogsStore = defineStore("logs", {
  state: () => ({
    entries: [] as LogEntry[],
  }),
  actions: {
    async refresh() {
      this.entries = await api<LogEntry[]>("/api/logs?limit=200");
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
