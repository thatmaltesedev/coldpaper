import './style.css';
import { initBackupUi } from './app/backup-ui';
import { initRestoreUi } from './app/restore-ui';
import { $ } from './app/dom';
import { setupTabs } from './app/tabs';

setupTabs();
initBackupUi();
initRestoreUi();

$('#app-version').textContent = `v${__APP_VERSION__}`;

if (__OFFLINE_BUILD__) {
  // The single-file copy IS the offline artifact - no service worker, no self-link.
  $('#offline-line').textContent =
    'You are running the single-file offline copy. It keeps working with no internet, from any folder or USB stick.';
} else if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Offline support is a bonus, never a blocker.
    });
  });
}
