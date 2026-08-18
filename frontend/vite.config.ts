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
    // Every path the backend serves must be listed here. Anything missing is silently answered by
    // this dev server with index.html instead of 404ing, so the failure looks like a tiny corrupt
    // file rather than a routing mistake — a download of a 300-byte "video" is what that looks
    // like from the browser.
    proxy: {
      "/api": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
      "/hls": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
      "/recordings": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
      "/exports": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
      "/edit-captures": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
    },
  },
});
