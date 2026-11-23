import type { AgentsApi } from '@jeevanand/agent-browserbox/ui';
import type { Kernel } from '@/kernel/api';

/**
 * The app's kernel client also reaches the agent (its agent worker): the
 * kernel itself has no agent, so this is how app code gets to it.
 */
export function agentsOf(os: Kernel): AgentsApi {
  return (os as Kernel & { agents: AgentsApi }).agents;
}
