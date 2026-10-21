import { defineConfig } from 'vite';
// Builds a single self-contained IIFE: probe/dist/probe.js
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', name: 'ThinkAloudProbe', formats: ['iife'], fileName: () => 'probe.js' },
    outDir: 'dist',
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
  },
});
