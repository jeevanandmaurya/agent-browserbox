import { AgentManager } from '@/agent/manager';
import { KernelCore } from '@/kernel/kernel';
import { ShellManager } from '@/shell/manager';
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

const os = new KernelCore();
os.agents = new AgentManager(os);
os.shells = new ShellManager(os);
const server = new KernelServer(os, shared);
void os.start().then(() => os.mark('kernel-ready'));

if (!shared) {
  // Kernels in different windows share IndexedDB/OPFS; keep their settings replicas in step.
  const channel = new BroadcastChannel('bbx-settings');
  os.onSettingWritten = (key, value) => channel.postMessage({ key, value });
  channel.onmessage = (e: MessageEvent<{ key: string; value: unknown }>) => os.settings.applyRemote(e.data.key, e.data.value);
}

if (shared) scope.onconnect = (e) => server.connect(e.ports[0]!);
else scope.onmessage = (e) => e.data?.type === 'connect' && server.connect(e.ports[0]!);
