import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = `http://localhost:${process.env.PORT || 4000}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
    // E2E runs set VITE_NO_HMR=1 so edits elsewhere in the repo never reload a page mid-session.
    ...(process.env.VITE_NO_HMR ? { hmr: false } : {}),
    proxy: { '/api': { target: api, changeOrigin: false }, '/probe.js': api },
  },
  // @mediapipe/face_mesh is a global script, not a module: see src/participant/faceMeshShim.ts.
  resolve: { alias: { '@mediapipe/face_mesh': fileURLToPath(new URL('./src/participant/faceMeshShim.ts', import.meta.url)) } },
  // Pre-bundled up front: discovering it lazily (eye tracking is opt-in) would reload the page mid-session.
  optimizeDeps: { include: ['webgazer'] },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 4000 },
});
