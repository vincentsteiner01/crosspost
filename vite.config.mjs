import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const pages = [
  'index.html', 'login/index.html', 'signup/index.html', 'privacy/index.html', 'terms/index.html',
  'dashboard/index.html', 'oauth/callback/index.html',
];

export default defineConfig({
  // GitHub Pages serves a project from /<repository>/; the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH || '/',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p.replace(/\/?index\.html$/, '') || 'main', resolve(import.meta.dirname, p)])),
    },
  },
});
