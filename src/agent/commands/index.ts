import { agentCommand } from './agent';
import { buildCommand, deployCommand, ghCommand } from './publish';
import { setupCommand } from './setup';

/** Shell commands that need the agent layer (models, sessions, publishing). Added to every shell by `installAgents`. */
export const AGENT_COMMANDS = [setupCommand, agentCommand, ghCommand, deployCommand, buildCommand];
