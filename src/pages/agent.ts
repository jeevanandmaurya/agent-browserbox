import '../ui/base.css';
import agentApp from '@/apps/agent/index';
import { connectKernel } from '@/client/connect';
import { RemoteKernel } from '@/client/remote-kernel';
import { followTheme, mountStandalone } from '@/ui/standalone';

/**
 * The agent's own window. There is no desktop here: this page connects to the
 * headless kernel and renders one thing, the agent. The desktop GUI is a
 * separate page that is only loaded if something asks for it.
 */
const os = new RemoteKernel(connectKernel());
followTheme(os);
os.mark('page');

mountStandalone(os, agentApp, 'Agent', document.getElementById('app')!).then(
  () => os.mark('ready'),
  (err: Error) => {
    document.getElementById('app')!.textContent = `BrowserBox could not start: ${err.message}`;
  },
);

if ('serviceWorker' in navigator && import.meta.env.PROD) addEventListener('load', () => void navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => undefined));
(globalThis as unknown as { bbx: RemoteKernel }).bbx = os;
