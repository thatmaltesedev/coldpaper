/// <reference types="vite/client" />

/** App version injected at build time from package.json. */
declare const __APP_VERSION__: string;
/** True in the single-file offline build (no service worker, no offline-copy link). */
declare const __OFFLINE_BUILD__: boolean;
