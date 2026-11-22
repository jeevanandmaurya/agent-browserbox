import { agentCommand } from './agent';
import { deployCommand, ghCommand } from './publish';
import { setupCommand } from './setup';

/** Shell commands that need the agent layer (models, sessions, publishing). Added to every shell by `installAgents`. (`build` is the runtime's own.) */
export const AGENT_COMMANDS = [setupCommand, agentCommand, ghCommand, deployCommand];
