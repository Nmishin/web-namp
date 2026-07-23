import { defineConfig } from 'vite';

// The static GitHub Pages build (`npm run build:pages` → VITE_STATIC=1) is
// served from https://<user>.github.io/web-namp/, so assets must resolve under
// that sub-path. A normal build/dev is served from the root, so base stays '/'.
const base = process.env.VITE_STATIC ? '/web-namp/' : '/';

// NOTE: `@shared` is a *type-only* alias (see tsconfig.json "paths"). Every
// import from it must be `import type { ... }`, which is fully erased at
// build time — so no runtime resolve.alias entry is needed here.
export default defineConfig({
  base,
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8058',
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: 'http://localhost:8058',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
  },
});
