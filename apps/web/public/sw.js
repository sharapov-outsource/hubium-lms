// Hubium service worker: offline fallback page and Web Push. Authenticated pages are
// never cached; only navigations that fail fall back to /offline.
const CACHE = 'hubium-v2';
const OFFLINE = '/offline';
const ASSETS = '/_next/static/';

// The offline page with the scripts and styles it loads: without them it would not come to
// life offline, and the page shown in its place would be an error.
async function precache() {
  const cache = await caches.open(CACHE);
  const page = await fetch(new Request(OFFLINE, { cache: 'reload' }));
  if (!page.ok) throw new Error(`${OFFLINE}: ${page.status}`);
  const html = await page.clone().text();
  const assets = [
    ...new Set([...html.matchAll(/["'](\/_next\/static\/[^"'?#\s]+)/g)].map((m) => m[1])),
  ];
  await cache.put(OFFLINE, page);
  await cache.addAll(['/icons/icon-192.png', ...assets]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE).then((r) => r ?? Response.error())),
    );
    return;
  }
  // the offline page's own scripts and styles, when the network does not answer
  if (request.method === 'GET' && new URL(request.url).pathname.startsWith(ASSETS))
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then((r) => r ?? Response.error())),
    );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    // The server always sends a title; the host name stands in for a malformed message.
    self.registration.showNotification(data.title || self.location.hostname, {
      body: data.body || '',
      tag: data.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins)
        if (w.url.startsWith(self.location.origin) && 'focus' in w)
          return w.navigate(url).then((c) => (c ?? w).focus());
      return self.clients.openWindow(url);
    }),
  );
});
