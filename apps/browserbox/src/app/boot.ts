import { BrowserBox, VERSION as RUNTIME_VERSION } from '@jeevanand/agent-browserbox-sdk';
import { RemoteKernel } from '@jeevanand/agent-browserbox-runtime/client';
import { AgentClient } from './agent-client';
import { attachAgents } from './agents';

/**
 * How a BrowserBox app window starts. The app is a client of the released
 * packages: it boots the runtime release through the SDK, on the site's own
 * kernel (`site: true`, so files, settings and keys are where they always
 * were), drives the kernel through the SDK's kernel channel, and runs the
 * agent package in its agent worker.
 */

/**
 * Where the runtime is served: the release of the SDK's own version, next to
 * the app (`/runtime/<version>/`). The development server serves the built
 * runtime package there too (npm run build:runtime first).
 */
export const RUNTIME_URL: string =
  import.meta.env.VITE_RUNTIME_URL || new URL(`../runtime/${RUNTIME_VERSION}/`, location.href).href;

/** Starts (or joins) the app's agent worker and returns a port to it. */
function agentWorkerPort(): MessagePort {
  if ('SharedWorker' in globalThis) return new SharedWorker(new URL('./agent-worker.ts', import.meta.url), { type: 'module', name: 'bbx-agent' }).port;
  // No SharedWorker (some mobile browsers): one agent worker per window.
  const worker = new Worker(new URL('./agent-worker.ts', import.meta.url), { type: 'module', name: 'bbx-agent' });
  const ch = new MessageChannel();
  worker.postMessage({ type: 'connect' }, [ch.port2]);
  return ch.port1;
}

/** This window's handle on the kernel, with agent calls going to the agent worker. */
export function appKernel(): RemoteKernel {
  const box = BrowserBox.boot({ runtimeUrl: RUNTIME_URL, site: true, timeoutMs: 60_000 });
  const os = new RemoteKernel(box.then((b) => b.kernelPort()));

  // Held while this window lives; the agent worker watches it to learn that the window closed.
  const lock = `bbx-app-window-${crypto.randomUUID()}`;
  void navigator.locks?.request(lock, () => new Promise(() => undefined));
  const port = agentWorkerPort();
  // The agent works in the box this window booted: lend it a connection when it asks.
  port.addEventListener('message', (e: MessageEvent<{ k?: string; n?: string }>) => {
    if (e.data?.k !== 'evt' || e.data.n !== 'box:need') return;
    void box
      .then((b) => b.share())
      .then((shared) => port.postMessage({ k: 'evt', n: 'box', p: shared }, [shared]));
  });
  attachAgents(os, new AgentClient(Promise.resolve(port), os, lock));
  return os;
}
