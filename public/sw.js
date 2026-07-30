/* Filament Library service worker — app shell offline, inventory read-only offline. */

const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;

const SHELL_FILES = [
  '/',
  '/styles.css',
  '/app.js',
  '/spool.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // App shell for any client-side route (including the /f/<id> QR links).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/', { cacheName: SHELL })),
    );
    return;
  }

  // Inventory data: fresh when online, last-known when not.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request, { cacheName: DATA })
          .then((hit) => hit || Response.json(
            { error: 'Offline — no cached copy of this request.' },
            { status: 503 },
          ))),
    );
    return;
  }

  // Static assets: serve cached immediately, refresh in the background.
  event.respondWith(
    caches.match(request, { cacheName: SHELL }).then((hit) => {
      const network = fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
        }
        return res;
      });
      return hit || network;
    }),
  );
});
