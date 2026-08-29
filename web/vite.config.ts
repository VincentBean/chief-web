import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DEV_API_TARGET = process.env.CHIEF_WEB_DEV_API ?? 'http://localhost:8080';

// The production bundle is served by the Express server from `web/dist`; in dev
// Vite proxies `/api` to the server so the frontend talks to the same routes.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: DEV_API_TARGET, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
