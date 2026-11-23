import type { AgentsApi } from '@jeevanand/agent-browserbox/ui';
import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';

const clients = new WeakMap<object, AgentsApi>();

/** Pairs a window's kernel client with its agent client (see appKernel). */
export function attachAgents(os: Kernel, agents: AgentsApi): void {
  clients.set(os, agents);
  // For scripts and the console: bbx.agents, as before.
  Object.defineProperty(os, 'agents', { value: agents, configurable: true });
}

/** The agent (the app's agent worker), for app code: the kernel itself has no agent. */
export function agentsOf(os: Kernel): AgentsApi {
  const a = clients.get(os);
  if (!a) throw new Error('this window has no agent client');
  return a;
}
