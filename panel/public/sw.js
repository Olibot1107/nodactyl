// Force new SW to activate immediately rather than waiting for all tabs to close
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(clients.claim()));

async function getStoredToken() {
  try {
    const cache = await caches.open('nodactyl-auth');
    const res = await cache.match('/sw-token');
    if (!res) return null;
    const { token } = await res.json();
    return token || null;
  } catch { return null; }
}

async function getMutedServers() {
  try {
    const cache = await caches.open('nodactyl-prefs');
    const res = await cache.match('/sw-prefs');
    if (!res) return [];
    const { mutedServers } = await res.json();
    return mutedServers || [];
  } catch { return []; }
}

function openOrFocus(url) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      try { if (new URL(c.url).pathname === url && 'focus' in c) return c.focus(); } catch {}
    }
    if (clients.openWindow) return clients.openWindow(url);
  });
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const data = event.data?.json() || {};
    const serverPath = data.url || '/';

    const [windowList, muted] = await Promise.all([
      clients.matchAll({ type: 'window', includeUncontrolled: true }),
      getMutedServers(),
    ]);

    // Skip if user has any panel tab focused or visible
    const isViewing = windowList.some(c => {
      try {
        return new URL(c.url).origin === self.location.origin
          && (c.focused || c.visibilityState === 'visible');
      } catch { return false; }
    });
    if (isViewing) return;

    // Skip if user has muted this server
    if (data.serverId && muted.includes(data.serverId)) return;

    const actions = data.canStart ? [{ action: 'start', title: 'Start Server' }] : [];

    return self.registration.showNotification(data.title || 'Nodactyl', {
      body: data.body || '',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: serverPath,
      renotify: true,
      actions,
      data: { url: serverPath, serverId: data.serverId, canStart: data.canStart },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { url, serverId } = event.notification.data || {};

  if (event.action === 'start' && serverId) {
    event.waitUntil(
      getStoredToken().then(token => {
        if (!token) return openOrFocus(url || '/dashboard');
        return fetch(`/api/servers/${serverId}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ action: 'start' }),
        })
          .then(r => r.ok ? undefined : openOrFocus(url || '/dashboard'))
          .catch(() => openOrFocus(url || '/dashboard'));
      })
    );
    return;
  }

  event.waitUntil(openOrFocus(url || '/dashboard'));
});
