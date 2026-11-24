import { loadSchedules, SCHEDULES_KEY } from '@jeevanand/agent-browserbox/ui';
import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';

/**
 * Scheduled tasks run only while BrowserBox is open. When it is installed as
 * an app, Chromium can wake its service worker now and then (Periodic
 * Background Sync); the worker cannot run the agent, but it can tell you a
 * task is due. For that, windows keep a short summary of when tasks are next
 * due where the worker can read it (Cache Storage).
 */
const FLAGS = 'bbx-flags';
const TAG = 'bbx-scheduled-tasks';
const key = (profile: string) => `https://flags.browserbox.local/schedules/${encodeURIComponent(profile)}`;

type PeriodicSync = { register(tag: string, o: { minInterval: number }): Promise<void>; unregister(tag: string): Promise<void>; getTags(): Promise<string[]> };

async function publish(os: Kernel, profile: string): Promise<void> {
  const tasks = loadSchedules(os)
    .filter((t) => t.enabled && t.missed === 'run')
    .map((t) => ({ name: t.name, nextRun: t.nextRun }));
  const cache = await caches.open(FLAGS);
  if (tasks.length) await cache.put(key(profile), new Response(JSON.stringify({ profile, tasks }), { headers: { 'content-type': 'application/json' } }));
  else await cache.delete(key(profile));
  // Ask for wake-ups only while there is something to remind about, and only where the browser offers it.
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  const sync = (reg as (ServiceWorkerRegistration & { periodicSync?: PeriodicSync }) | undefined)?.periodicSync;
  if (!sync) return;
  if (!tasks.length) return void (await sync.unregister(TAG).catch(() => undefined));
  const state = await navigator.permissions.query({ name: 'periodic-background-sync' as PermissionName }).catch(() => null);
  if (state?.state === 'granted') await sync.register(TAG, { minInterval: 60 * 60_000 }).catch(() => undefined);
}

/** Keeps the summary up to date for this profile's windows. */
export function followSchedules(os: Kernel, profile: string): void {
  if (typeof caches === 'undefined') return;
  const run = () => void publish(os, profile).catch(() => undefined);
  run();
  os.bus.on('settings:change', ({ key: k }) => k === SCHEDULES_KEY && run());
}
