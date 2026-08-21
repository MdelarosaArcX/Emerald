import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// Defaults match LiveEdit's own .env.example (port 5173 / backend 4000) — the multi-machine
// production layout, where this frontend is the only thing on its box and never collides with
// anything. Override via VITE_DEV_PORT / VITE_DEV_BACKEND_URL (see .env) when running LiveEdit
// side-by-side with the main Emerald frontend/backend on one machine for local testing, since
// both of those default to 5173/5000 too.
//
// Vite does NOT populate process.env from .env for its own config file — that .env loading only
// ever feeds import.meta.env in client code — so reading process.env.VITE_DEV_PORT directly here
// always saw undefined and silently fell back to the 5173 default, regardless of what .env said.
// loadEnv() is Vite's documented way to read the same .env files from inside defineConfig itself.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devPort = Number(env.VITE_DEV_PORT) || 5173;
  const backendOrigin = env.VITE_DEV_BACKEND_URL || 'http://localhost:4000';

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: devPort,
      // Explicit 0.0.0.0 (matches Emerald frontend's own `vite --host 0.0.0.0`) — otherwise
      // Vite's default host binds this dev server to the IPv6 loopback only ([::1]), never
      // claiming the IPv4 127.0.0.1 address at all, which leaves that address's port free for
      // anything else (e.g. Emerald's frontend) to grab. strictPort makes a port collision a
      // loud startup error instead of Vite silently drifting to a different port, which is
      // exactly how a stale Emerald instance ended up squatting on this port previously.
      host: true,
      strictPort: true,
      proxy: {
        '/api': {
          target: backendOrigin,
          changeOrigin: true,
        },
        // Generated media (playable proxies + rendered outputs) served by the LiveEdit backend.
        '/proxies': { target: backendOrigin, changeOrigin: true },
        '/renders': { target: backendOrigin, changeOrigin: true },
        // Media imported into the project — served from the backend's imports directory and played
        // by URL from the timeline, so it has to be reachable through the dev server like the two
        // generated-media mounts above.
        '/media-imports': { target: backendOrigin, changeOrigin: true },
        '/socket.io': {
          target: backendOrigin,
          ws: true,
          // A proxied socket.io WebSocket gets an ECONNRESET whenever it's torn down abruptly —
          // a page reload, an HMR full-reload, or the backend restarting under nodemon. That's
          // expected and harmless (the client reconnects), so don't let http-proxy spam it to
          // the console as an error; surface anything that isn't a reset.
          configure: (proxy) => {
            proxy.on('error', (err: NodeJS.ErrnoException) => {
              if (err.code !== 'ECONNRESET') {
                console.error('[socket.io proxy]', err.message);
              }
            });
          },
        },
      },
    },
  };
});
