/* Filament Library service worker — app shell offline, inventory read-only offline. */

const VERSION = 'v90';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;

const SHELL_FILES = [
  '/',
  '/styles.css',
  '/app.js',
  '/spool.js',
  '/label.js',
  // The scanner's decoder (vendor/barcode-detector.js and its ~1 MB wasm) is
  // deliberately not precached — it's only needed if you actually open the
  // scanner, and it gets cached on first use like any other static asset.
  '/scan.js',
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

  /*
   * Downloads are not inventory data and must not be cached. An export is the
   * whole library in one response — caching it would park a full copy in the
   * browser's storage indefinitely, and serve a stale one to somebody who
   * pressed the button expecting today's.
   */
  if (url.pathname.startsWith('/api/export')) return;

  // Inventory data: fresh when online, last-known when not.
  if (url.pathname.startsWith('/api/')) {
    /*
     * Searches and deep pages are answered but never kept.
     *
     * The cache is keyed by full URL, and searching is per keystroke, so
     * typing "black" filed five entries — q=b, q=bl, q=bla, q=blac, q=black
     * — and each one stayed until the next deploy. None of them can ever be
     * used again either: coming back offline only helps if you retype the
     * same half-finished word. It was unbounded growth buying nothing.
     *
     * What is worth having offline is the plain list, the stats, the catalog
     * and a spool you opened, and those all still cache.
     */
    const transient = url.searchParams.has('q') || url.searchParams.has('offset');

    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok && !transient) {
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

  // Static assets: network first, falling back to cache when offline.
  //
  // Deliberately not stale-while-revalidate. That serves the previous copy and
  // only refreshes the cache afterwards, so every deploy would land one page
  // load late — you'd get the old JS against the new API. Freshness matters
  // more here than shaving milliseconds off a LAN request.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { cacheName: SHELL })),
  );
});
