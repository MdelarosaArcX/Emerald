import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
      "/hls": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
      "/recordings": process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:5000",
    },
  },
});
