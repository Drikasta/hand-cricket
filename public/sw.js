const CACHE = 'hand-cricket-v6';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/game.js',
  '/manifest.json',
  '/icon.svg',
];

// Install — cache app shell
self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — serve from cache, fall back to network
self.addEventListener('fetch', ev => {
  // Only handle GET requests for our own origin
  if (ev.request.method !== 'GET') return;
  if (!ev.request.url.startsWith(self.location.origin)) return;

  ev.respondWith(
    caches.match(ev.request).then(cached => {
      if (cached) return cached;
      return fetch(ev.request).then(response => {
        // Don't cache non-200 responses or opaque responses
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(ev.request, clone));
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (ev.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});
