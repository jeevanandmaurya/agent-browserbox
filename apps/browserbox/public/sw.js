// BrowserBox service worker: makes the OS boot instantly and work offline.
// Hashed build assets are immutable → cache-first. The HTML shell is
// stale-while-revalidate so updates arrive on the next launch.
//
// It can also make every page cross-origin isolated (Settings → Environment):
// static hosts such as GitHub Pages cannot send the COOP/COEP headers that
// SharedArrayBuffer, WebAssembly threads and in-browser Node.js need, so the
// worker adds them to the responses it serves.
const CACHE = 'bbx-v4';
// The runtime this build ships (runtime/<version>/): the build writes it in.
const RUNTIME = '__BBX_RUNTIME__';
// Pages to have before the first visit ends, so the next start works offline and at once.
const PRECACHE = ['./', './agent/', './os/', './docs/', './preview/frame.html', ...['embed/', 'kernel/bridge.html', 'kernel/sandbox.html', 'kernel/sandbox-net.html'].map((p) => `./${RUNTIME}${p}`)];
// Only the app's own old caches are cleared on update. Installed packages
// (bbx-packs), npm modules (bbx-npm), in-browser models (webllm/*) and flags stay.
const OWN = /^bbx-v\d+$/;
const FLAGS = 'bbx-flags';
// The same absolute key from every page and from here (relative keys resolve differently).
const COI_KEY = 'https://flags.browserbox.local/coi';

self.addEventListener('install', (e) => {
  // One by one: a page that fails to load is fetched on first use instead, and never stops the update.
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => OWN.test(k) && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Whether to isolate, re-read at most every few seconds (the setting writes it to Cache Storage).
let isolate = false;
let checked = 0;
async function isolated() {
  if (Date.now() - checked > 3000) {
    checked = Date.now();
    isolate = !!(await caches.open(FLAGS).then((c) => c.match(COI_KEY)).catch(() => null));
  }
  return isolate;
}

/** Adds the cross-origin isolation headers to a same-origin response. */
function withIsolation(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // credentialless: cross-origin resources (CDNs, esm.sh, model weights) load without needing CORP headers.
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // never touch LLM / network calls
  const immutable = url.pathname.includes('/assets/');
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = (await cache.match(req)) ?? (await caches.open('bbx-packs').then((c) => c.match(req)));
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      let res;
      if (hit && immutable) res = hit;
      else if (hit) {
        e.waitUntil(refresh);
        res = hit;
      } else res = (await refresh) ?? Response.error();
      return (await isolated()) ? withIsolation(res) : res;
    })(),
  );
});
