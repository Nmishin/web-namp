/* web-namp service worker — vanilla, no build step.
   Base-agnostic: the SW lives at the app's base root (e.g. "/" or "/web-namp/"),
   so its own directory doubles as the start page / offline navigation fallback. */

const CACHE = 'web-namp-v1';

// Directory this SW is served from == the app base == the start page.
const START_URL = new URL('.', self.location).pathname;

self.addEventListener('install', (event) => {
  // Take over as soon as the new SW is installed.
  self.skipWaiting();
  // Warm the cache with the start page so offline navigations have a fallback.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(START_URL))
      .catch((err) => {
        console.warn('[web-namp][sw] precache of start page failed:', err);
      }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      // Start controlling open pages immediately.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only cache GET requests.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Same-origin only — never touch cross-origin hosts (media, CDNs, analytics).
  if (url.origin !== self.location.origin) return;

  // Never cache the API.
  if (url.pathname.includes('/api/')) return;

  // Navigations: network-first, fall back to cache, then to the start page.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
          return fresh;
        } catch (err) {
          console.warn('[web-namp][sw] navigation offline, falling back to cache:', err);
          const cached = await caches.match(request);
          if (cached) return cached;
          const start = await caches.match(START_URL);
          if (start) return start;
          return Response.error();
        }
      })(),
    );
    return;
  }

  // Other same-origin assets: cache-first, then network (and cache the result).
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        // Only store complete, same-origin ("basic") successful responses.
        if (fresh && fresh.ok && fresh.type === 'basic' && fresh.status !== 206) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (err) {
        console.warn('[web-namp][sw] asset fetch failed:', err);
        return Response.error();
      }
    })(),
  );
});
