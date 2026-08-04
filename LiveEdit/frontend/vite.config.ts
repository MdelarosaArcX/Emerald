import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// Defaults are LiveEdit's own ports (frontend 5174 / backend 5001), chosen to stay clear of the
// main Emerald frontend/backend (5173/5000) so both stacks can run side-by-side on one machine.
// Override via VITE_DEV_PORT / VITE_DEV_BACKEND_URL (see .env) for a different layout.
//
// Vite does NOT populate process.env from .env for its own config file — that .env loading only
// ever feeds import.meta.env in client code — so reading process.env.VITE_DEV_PORT directly here
// always sees undefined and silently falls back to the default, regardless of what .env says.
// loadEnv() is Vite's documented way to read the same .env files from inside defineConfig itself.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devPort = Number(env.VITE_DEV_PORT) || 5174;
  const backendOrigin = env.VITE_DEV_BACKEND_URL || 'http://localhost:5001';

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
      // loud startup error instead of Vite silently drifting to a different port.
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
        '/socket.io': {
          target: backendOrigin,
          ws: true,
          // A proxied socket.io WebSocket gets an ECONNRESET whenever it's torn down abruptly —
          // a page reload, an HMR full-reload, or the backend restarting under nodemon. That's
          // expected and harmless (the client reconnects), so don't let http-proxy spam it to the
          // console as an error; surface anything that isn't a reset.
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
