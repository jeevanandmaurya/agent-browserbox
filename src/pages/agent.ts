import '../ui/base.css';
import agentApp from '@/apps/agent/index';
import { appKernel } from '@/app/boot';
import type { RemoteKernel } from '@/client/index';
import { bootConsole } from '@/ui/boot';
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
  .then(() => mountStandalone(os, agentApp, 'Agent', root, { embedsApps: true }))
  .then(
  () => os.mark('ready'),
  (err: Error) => {
    document.getElementById('app')!.textContent = `BrowserBox could not start: ${err.message}`;
  },
);

if ('serviceWorker' in navigator && import.meta.env.PROD) addEventListener('load', () => void navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => undefined));
(globalThis as unknown as { bbx: RemoteKernel }).bbx = os;
