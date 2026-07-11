import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json';

// Offline build: everything (JS, CSS, the zxing wasm binary) inlined into ONE
// self-contained HTML file. The main build copies it into dist/ as
// `coldpaper-offline.html` — the "keep it on a USB stick" artifact.
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __OFFLINE_BUILD__: 'true',
  },
  build: {
    target: 'es2022',
    outDir: 'dist-offline',
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
  },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
});
