import '../ui/base.css';
import agentApp from '@/apps/agent/index';
import { appKernel, PROFILE } from '@/app/boot';
import type { RemoteKernel } from '@jeevanand/agent-browserbox-runtime/client';
import { bootConsole } from '@/ui/boot';
import { profileGate } from '@/ui/profiles';
import { followTheme, mountStandalone } from '@/ui/standalone';

/**
 * The agent's own window: a complete app on top of the headless kernel —
 * chat, built-in workbench (files, terminal, preview…) and settings. The
 * desktop GUI is a separate page, opened only when the user asks for it.
 */
const os = appKernel();
followTheme(os);
os.mark('page');

const root = document.getElementById('app')!;
bootConsole(os, root)
  .then(() => profileGate(os, root))
  .then(() => mountStandalone(os, agentApp, 'Agent', root, { embedsApps: true }))
  // Reminders of due scheduled tasks for the installed app (loaded after startup).
  .then(() => void Promise.all([PROFILE, import('@/app/background')]).then(([id, m]) => m.followSchedules(os, id)))
  .then(
  () => {
    os.mark('ready');
    // A newer release out: say so (cached pages would otherwise hide it until the next start).
    void import('@/app/updates').then((m) => m.watchUpdates(os));
  },
  (err: Error) => {
    document.getElementById('app')!.textContent = `BrowserBox could not start: ${err.message}`;
  },
);

if ('serviceWorker' in navigator && import.meta.env.PROD) addEventListener('load', () => void navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => undefined));
(globalThis as unknown as { bbx: RemoteKernel }).bbx = os;
