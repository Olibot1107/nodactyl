const CACHE = 'nodactyl-v1';
const SHELL = [
  '/css/style.css',
  '/js/api.js',
  '/favicon.svg',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Don't intercept API calls, socket.io, or non-GET
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // Cache-first for static assets (CSS, JS, SVG, fonts)
  if (SHELL.includes(url.pathname) || /\.(css|js|svg|png|ico|woff2?)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      }))
    );
    return;
  }

  // Network-first for HTML pages (always get fresh content when online)
  e.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
