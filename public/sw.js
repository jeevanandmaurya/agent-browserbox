// BrowserBox service worker: makes the OS boot instantly and work offline.
// Hashed build assets are immutable → cache-first. The HTML shell is
// stale-while-revalidate so updates arrive on the next launch.
const CACHE = 'bbx-v2';
// Tool packs installed by the user (see src/kernel/packs.ts). Kept across app updates.
const PACKS = 'bbx-packs';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './agent/', './os/', './kernel/bridge.html', './kernel/sandbox.html', './kernel/sandbox-net.html'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== PACKS).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // never touch LLM / network calls
  const immutable = url.pathname.includes('/assets/');
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = (await cache.match(req)) ?? (await caches.open(PACKS).then((c) => c.match(req)));
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
