import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:4000',
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
});
