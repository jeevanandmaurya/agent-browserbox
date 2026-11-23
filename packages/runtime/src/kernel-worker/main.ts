import { fromWorkerName } from '../kernel/instance';
import { KernelCore } from '../kernel/kernel';
import { REGISTRY } from '../packages/registry';
import { ShellManager } from '../shell/manager';
import { KernelServer } from './server';

/**
 * Kernel entry point. Runs as a SharedWorker so every BrowserBox window —
 * agent, desktop, or any other frontend — talks to the same kernel, which
 * stays alive with no GUI as long as one window is open. Where SharedWorker
 * is unavailable it runs as a dedicated worker (one kernel per window,
 * sharing only storage).
 */
type Handler = ((e: MessageEvent) => void) | null;
const scope = self as unknown as { onconnect: Handler; onmessage: Handler };
const shared = 'SharedWorkerGlobalScope' in self;

// This is the composition root: the one place that assembles the layers (see tests/layers.test.ts).
// The worker's name says which kernel this is: the app's, or an SDK box's.
const instance = fromWorkerName(self.name);
const os = new KernelCore({ packages: REGISTRY, instance });
os.shells = new ShellManager(os);
const server = new KernelServer(os, shared);
const ready = os.start().then(() => os.mark('kernel-ready'));

if (!shared) {
  // Kernels in different windows share IndexedDB/OPFS; keep their settings replicas in step.
  const channel = new BroadcastChannel(`bbx-settings:${self.name}`);
  os.onSettingWritten = (key, value) => channel.postMessage({ key, value });
  channel.onmessage = (e: MessageEvent<{ key: string; value: unknown }>) => os.settings.applyRemote(e.data.key, e.data.value);
}

const accept = (port: MessagePort) => server.connect(port);
if (shared) scope.onconnect = (e) => accept(e.ports[0]!);
else scope.onmessage = (e) => e.data?.type === 'connect' && accept(e.ports[0]!);
