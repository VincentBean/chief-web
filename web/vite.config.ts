import { createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const DEV_API_TARGET = process.env.CHIEF_WEB_DEV_API ?? 'http://localhost:8080';

// The call's VAD (voice US-009) fetches its Silero model, its worklet bundle
// and onnxruntime's wasm (+ the .mjs loaders that import them) at runtime from
// `/voice/vad/`. The packages are hoisted to the workspace root, so resolve
// their `dist/` folders instead of assuming a path.
const require = createRequire(import.meta.url);
const vadDist = path.dirname(require.resolve('@ricky0123/vad-web'));
const ortDist = path.dirname(require.resolve('onnxruntime-web'));
const posix = (dir: string): string => dir.split(path.sep).join('/');

// The production bundle is served by the Express server from `web/dist`; in dev
// Vite proxies `/api` to the server so the frontend talks to the same routes.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      // Only the plain wasm build: vad-web imports `onnxruntime-web/wasm`,
      // which never asks for the jsep/jspi/asyncify variants (~60 MB more).
      targets: [
        `${posix(vadDist)}/silero_vad_v5.onnx`,
        `${posix(vadDist)}/vad.worklet.bundle.min.js`,
        `${posix(ortDist)}/ort-wasm-simd-threaded.wasm`,
        `${posix(ortDist)}/ort-wasm-simd-threaded.mjs`,
      ].map((src) => ({ src, dest: 'voice/vad', rename: { stripBase: true } })),
    }),
  ],
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
