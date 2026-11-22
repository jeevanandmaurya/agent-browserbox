import { agentRpc } from '@/agent/rpc';
import { installAgents } from '@/agent/service';
import { registerApps } from '@/kernel/apps';
import type { KernelCore } from '@/kernel/kernel';
import { APP_MANIFESTS } from '@/ui/app-manifest';
import type { KernelServer } from './server';

/**
 * What the BrowserBox app's own build adds to the kernel worker: its agent
 * service and its list of apps. The runtime release has neither. Goes away
 * when the app runs on the runtime release (its agent then runs in the app).
 */
export function installAppServices(os: KernelCore, server: KernelServer): void {
  registerApps(APP_MANIFESTS);
  installAgents(os);
  server.use(agentRpc(os));
}
