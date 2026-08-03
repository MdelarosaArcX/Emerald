import { defineStore } from "pinia";

export type DbCheck = {
  label: string;
  connected: boolean;
  latencyMs: number | null;
  host: string | null;
  error?: string;
};

export const useDatabasesStore = defineStore("databases", {
  state: () => ({
    db1: null as DbCheck | null,
    db2: null as DbCheck | null,
    db3: null as DbCheck | null,
  }),
  actions: {
    async refresh() {
      try {
        const result = await api<{ db1: DbCheck; db2: DbCheck; db3: DbCheck }>("/api/system/databases");
        this.db1 = result.db1;
        this.db2 = result.db2;
        this.db3 = result.db3;
      } catch {
        // A failed poll shouldn't break the page — keep showing the last known state.
      }
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
