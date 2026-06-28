// Minimal service worker — required for PWA install prompt, no caching.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
