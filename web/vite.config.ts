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
    proxy: { '/api': { target: api, changeOrigin: false }, '/probe.js': api },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 4000 },
});
