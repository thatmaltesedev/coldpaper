import { defineConfig } from 'vite';
import { injectServiceWorker } from './plugins/sw-plugin';
import { copyOfflineBuild } from './plugins/offline-copy';
import pkg from './package.json';

// Main build: multi-file PWA deployed to GitHub Pages. `base: './'` keeps every
// URL relative so the same bundle works at any path (Pages subpath, file://-adjacent
// hosting, mirrors).
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __OFFLINE_BUILD__: 'false',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  plugins: [injectServiceWorker(), copyOfflineBuild()],
});
