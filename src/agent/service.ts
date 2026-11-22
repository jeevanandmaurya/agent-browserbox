import type { KernelCore } from '@/kernel/kernel';
import { AGENT_HOME } from '@/kernel/paths';
import { contributeCommands } from '@/shell/index';
import './api';
import { McpHub } from './ext/mcp';
import { AGENT_COMMANDS } from './commands/index';
import { AgentManager } from './manager';

/**
 * Adds the agent service to a kernel: agent sessions, MCP connectors, the
 * agent's shell commands and the example skills seeded on first boot. Call before `os.start()`.
 */
export function installAgents(os: KernelCore): void {
  os.mcp = new McpHub(os);
  os.agents = new AgentManager(os);
  contributeCommands(...AGENT_COMMANDS);
  os.seeders.push(async () => {
    // Example skills, agents and commands; only when the folder has never existed.
    if (await os.fs.exists(`${AGENT_HOME}/skills`)) return;
    const { SEED } = await import('./ext/library');
    for (const [path, text] of SEED) await os.fs.writeFile(path, text);
  });
}
