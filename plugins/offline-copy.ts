import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Copies the single-file offline build (produced first by
 * `vite build --config vite.offline.config.ts`) into dist/ so the app footer
 * can link to it. Warns instead of failing so `vite build` alone still works.
 */
export function copyOfflineBuild(): Plugin {
  return {
    name: 'coldpaper:copy-offline',
    apply: 'build',
    closeBundle() {
      const src = resolve('dist-offline/index.html');
      const dest = resolve('dist/coldpaper-offline.html');
      if (existsSync(src)) {
        copyFileSync(src, dest);
      } else {
        this.warn('dist-offline/index.html missing - run the offline build first (npm run build does both)');
      }
    },
  };
}
