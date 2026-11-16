// BrowserBox service worker: makes the OS boot instantly and work offline.
// Hashed build assets are immutable → cache-first. The HTML shell is
// stale-while-revalidate so updates arrive on the next launch.
const CACHE = 'bbx-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './sandbox.html', './sandbox-net.html'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // never touch LLM / network calls
  const immutable = url.pathname.includes('/assets/');
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      if (hit && immutable) return hit;
      if (hit) {
        e.waitUntil(refresh);
        return hit;
      }
      return (await refresh) ?? Response.error();
    }),
  );
});
