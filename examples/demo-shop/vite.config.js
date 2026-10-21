import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Default base '/' — assets are referenced as /assets/index-<hash>.js and the
// router expects to live at '/'. The ThinkAloud app host serves each app on its
// own subdomain so this works unchanged.
export default defineConfig({ plugins: [react()] });
