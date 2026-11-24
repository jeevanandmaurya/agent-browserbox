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

// Installed as an app, Chromium may wake this worker now and then (Periodic
// Background Sync). It cannot run the agent (that needs a window), but it can
// say that a scheduled task is due while no BrowserBox window is open. Windows
// keep the summary it reads (app/background.ts).
self.addEventListener('periodicsync', (e) => {
  if (e.tag !== 'bbx-scheduled-tasks') return;
  e.waitUntil(remindDue());
});
async function remindDue() {
  const open = await self.clients.matchAll({ type: 'window' });
  if (open.length) return; // an open window runs them itself
  const cache = await caches.open(FLAGS);
  const now = Date.now();
  const due = [];
  for (const req of await cache.keys()) {
    if (!req.url.startsWith('https://flags.browserbox.local/schedules/')) continue;
    const s = await (await cache.match(req)).json().catch(() => null);
    for (const t of s?.tasks ?? []) if (t.nextRun <= now) due.push({ ...t, profile: s.profile });
  }
  if (!due.length) return;
  const names = due.map((t) => t.name);
  await self.registration.showNotification(due.length === 1 ? `Scheduled task due: ${names[0]}` : `${due.length} scheduled tasks are due`, {
    body: `${due.length === 1 ? '' : `${names.slice(0, 3).join(', ')}${due.length > 3 ? '…' : ''}. `}Open BrowserBox to run ${due.length === 1 ? 'it' : 'them'}.`,
    tag: 'bbx-scheduled-due',
    icon: './icon.svg',
    data: { url: new URL(`./agent/?profile=${encodeURIComponent(due[0].profile)}`, self.registration.scope).href },
  });
}
self.addEventListener('notificationclick', (e) => {
  const url = e.notification.data?.url;
  e.notification.close();
  if (!url) return;
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((list) => {
      const w = list.find((c) => c.url.startsWith(new URL('./agent/', self.registration.scope).href));
      return w ? w.focus() : self.clients.openWindow(url);
    }),
  );
});

// Shared to BrowserBox from another app (the manifest's share_target): keep what
// was shared for the agent page, then open it. Kept in Cache Storage under a
// one-off id; the page takes it and deletes it.
const SHARE = 'bbx-share';
async function receiveShare(req) {
  const form = await req.formData();
  const id = crypto.randomUUID();
  const cache = await caches.open(SHARE);
  const files = form.getAll('files').filter((f) => typeof f !== 'string');
  const meta = { title: String(form.get('title') ?? ''), text: String(form.get('text') ?? ''), url: String(form.get('url') ?? ''), files: files.map((f, i) => ({ key: `https://share.browserbox.local/${id}/${i}`, name: f.name || `shared-${i}`, type: f.type })) };
  for (const [i, f] of files.entries()) await cache.put(meta.files[i].key, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
  await cache.put(`https://share.browserbox.local/${id}`, new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  return Response.redirect(new URL(`./?shared=${id}`, req.url).href, 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/agent/share-target')) return e.respondWith(receiveShare(req));
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
