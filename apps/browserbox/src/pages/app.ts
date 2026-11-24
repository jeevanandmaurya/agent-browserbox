import '../ui/base.css';
import { appKernel } from '@/app/boot';
import type { RemoteKernel } from '@jeevanand/agent-browserbox-runtime/client';
import { APPS } from '@/ui/apps';
import { bootConsole } from '@/ui/boot';
import { profileGate } from '@/ui/profiles';
import { followTheme, mountStandalone } from '@/ui/standalone';

/**
 * One app in a tab of its own (app/?app=preview&args={…}): the same kernel as
 * every other window of this profile, so files, servers and settings are
 * shared, but a whole browser tab for the app.
 */
const os = appKernel();
followTheme(os);
os.mark('page');

const params = new URLSearchParams(location.search);
const id = params.get('app') ?? '';
let args: Record<string, unknown> = {};
try {
  args = JSON.parse(params.get('args') ?? '{}') as Record<string, unknown>;
} catch {
  /* bad arguments: open the app without them */
}

const root = document.getElementById('app')!;
bootConsole(os, root)
  .then(() => profileGate(os, root))
  .then(async () => {
    const app = APPS.find((a) => a.id === id && a.load);
    if (!app?.load) throw new Error(`there is no app called “${id}”`);
    document.title = `${app.name} — BrowserBox`;
    await mountStandalone(os, (await app.load()).default, app.name, root, { args, id });
  })
  .then(
    () => {
      os.mark('ready');
      void import('@/app/updates').then((m) => m.watchUpdates(os));
    },
    (err: Error) => {
      root.textContent = `BrowserBox could not open this: ${err.message}`;
    },
  );

if ('serviceWorker' in navigator && import.meta.env.PROD) addEventListener('load', () => void navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => undefined));
(globalThis as unknown as { bbx: RemoteKernel }).bbx = os;
