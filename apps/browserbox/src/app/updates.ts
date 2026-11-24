import type { RemoteKernel } from '@jeevanand/agent-browserbox-runtime/client';

/**
 * Tells people when a newer BrowserBox is out. The service worker serves pages
 * from its cache first (so BrowserBox starts at once and works offline), which
 * means a new release only shows on the launch after the one that fetched it,
 * and not at all while a window stays open. So every page reads version.json
 * (never cached) now and then, and says which parts are newer. "Update now"
 * drops the cached pages and reloads every BrowserBox window at once, so no
 * window keeps an old kernel running.
 */
const PARTS = [
  ['app', 'app'],
  ['runtime', 'kernel'],
  ['sdk', 'SDK'],
  ['agent', 'agent'],
] as const;
type Build = Record<(typeof PARTS)[number][0], string>;
const CHANNEL = 'bbx-update';
const DISMISSED = 'bbx-update-dismissed';
const EVERY = 3 * 3600_000;

let banner: HTMLElement | null = null;
let last = 0;

/** "agent 0.4.3 → 0.4.4": the parts that differ. */
export function changedParts(mine: Build, live: Partial<Build>): string[] {
  return PARTS.filter(([k]) => live[k] && live[k] !== mine[k]).map(([k, name]) => `${name} ${mine[k]} → ${live[k]}`);
}

async function check(os: RemoteKernel): Promise<void> {
  last = Date.now();
  let live: Partial<Build>;
  try {
    const res = await fetch(`${new URL('../version.json', location.href).href}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return; // a development server, or offline
    live = (await res.json()) as Partial<Build>;
  } catch {
    return;
  }
  const changed = changedParts(__BBX_BUILD__, live);
  // The kernel this window talks to is older than the page expects (another window started it).
  const kernel = os.version && os.version !== __BBX_BUILD__.runtime && !changed.some((c) => c.startsWith('kernel')) ? [`kernel ${os.version} running, ${__BBX_BUILD__.runtime} expected`] : [];
  const parts = [...changed, ...kernel];
  if (!parts.length) return;
  const key = JSON.stringify(live);
  try {
    if (localStorage.getItem(DISMISSED) === key) return;
  } catch {
    /* storage blocked */
  }
  show(parts, key);
  // Out of sight (the installed app in the background): a system notification too, if allowed.
  if (document.hidden && 'Notification' in globalThis && Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
    void reg?.showNotification('A new version of BrowserBox is available', { body: parts.join(', '), tag: 'bbx-update', icon: new URL('../icon.svg', location.href).href }).catch(() => undefined);
  }
}

function show(parts: string[], key: string): void {
  banner?.remove();
  const el = document.createElement('div');
  el.className = 'bbx-update';
  el.setAttribute('role', 'status');
  el.innerHTML = '<span class="bbx-update-text"><strong>A new version of BrowserBox is available</strong><span></span></span><button type="button" class="btn small primary">Update now</button><button type="button" class="btn small ghost">Later</button>';
  el.querySelector('.bbx-update-text span')!.textContent = parts.join(' · ');
  const [now, later] = el.querySelectorAll('button');
  now!.onclick = () => void updateNow();
  later!.onclick = () => {
    try {
      localStorage.setItem(DISMISSED, key);
    } catch {
      /* storage blocked */
    }
    el.remove();
  };
  Object.assign(el.style, {
    position: 'fixed', left: '50%', top: '10px', transform: 'translateX(-50%)', zIndex: '10000', display: 'flex', alignItems: 'center', gap: '10px',
    maxWidth: 'calc(100vw - 24px)', padding: '8px 10px 8px 14px', borderRadius: '12px', border: '1px solid var(--border, #444)',
    background: 'var(--panel, #222)', color: 'var(--text, #eee)', boxShadow: '0 8px 30px rgb(0 0 0 / 0.3)', font: '13px system-ui, sans-serif',
  });
  Object.assign((el.querySelector('.bbx-update-text') as HTMLElement).style, { display: 'grid', gap: '2px', minWidth: '0' });
  (el.querySelector('.bbx-update-text span') as HTMLElement).style.opacity = '0.75';
  document.body.append(el);
  banner = el;
}

/** Drops the cached pages, fetches the new service worker, and reloads every BrowserBox window. */
export async function updateNow(): Promise<void> {
  try {
    for (const k of await caches.keys()) if (/^bbx-v\d+$/.test(k)) await caches.delete(k);
  } catch {
    /* Cache Storage unavailable */
  }
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  await reg?.update().catch(() => undefined);
  try {
    new BroadcastChannel(CHANNEL).postMessage('reload');
  } catch {
    /* no BroadcastChannel */
  }
  location.reload();
}

/** Checks now, when the page comes back into view (at most every few hours), and every few hours. */
export function watchUpdates(os: RemoteKernel): void {
  try {
    new BroadcastChannel(CHANNEL).onmessage = (e) => e.data === 'reload' && location.reload();
  } catch {
    /* no BroadcastChannel */
  }
  setTimeout(() => void check(os), 3000);
  document.addEventListener('visibilitychange', () => !document.hidden && Date.now() - last > EVERY && void check(os));
  setInterval(() => void check(os), EVERY);
}
