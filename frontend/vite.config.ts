import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // Fail loudly if 5173 is already taken instead of silently drifting to the next free port —
    // that silent drift is what once let a stale instance of this dev server end up squatting on
    // LiveEdit's port (5174) on the same machine.
    strictPort: true,
    proxy: {
      "/api": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
      "/hls": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
      "/recordings": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
    },
  },
});
