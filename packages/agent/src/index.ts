/**
 * @jeevanand/agent-browserbox: the BrowserBox agent, as a library. It works in
 * a BrowserBox (reached through @jeevanand/agent-browserbox-sdk) and is the
 * same agent as the BrowserBox app's: tools, compaction, checkpoints and undo,
 * plan mode, skills, custom agents, sub-agents, MCP connectors and sessions.
 */
export { VERSION } from './version.js';
export { imageRef, isImagePath, MAX_IMAGE_BYTES } from './images.js';
export { decide, describeRule, loadRules, matches, RULES_KEY, saveRules, splitCommand, type PermRule, type RuleAction, type RuleScope } from './rules.js';

// The agent's view of a box, and what the app supplies.
export { AgentOs, Settings, Shell, type FilesLike, type WithFiles, type WithSettings, type ProcTable, type AgentOsOptions, type AgentUi, type AppInfo, type Notice, type SecretsApi, type SettingsApi } from './host/os.js';
export type { Capability, PermDecision, PermRequest, Prompter } from './host/perms.js';
export { BrowserSecrets } from './host/secrets.js';
export { AGENT_HOME, HOME } from './host/paths.js';

// The agent and its sessions.
export { Agent, MODE_TAG, type AgentEvent, type AgentHost, type TurnStats } from './agent.js';
export { AgentManager } from './manager.js';
export type { AgentHandle, AgentInfo, AgentSnapshot, AgentsApi, TurnChanges } from './api.js';
export { deleteSession, listSessions, loadSession, saveSession, titleFrom, type SessionFile, type SessionInfo } from './session.js';
export { Checkpoints, type Checkpoint } from './checkpoints.js';
export { diffFiles, type FileDiff } from './diff.js';

// Models and configuration.
export * from './config.js';
export { createProvider } from './providers/index.js';
export * from './providers/webllm-store.js';
export { ProviderError, type Block, type ContextReport, type ImageRef, type JsonSchema, type Msg, type Provider, type ToolSpec, type TurnRequest, type TurnResult, type Usage } from './types.js';

// Terminal commands an app can offer in its box's shell.
export { AGENT_COMMANDS, pathIn, SETUP_DONE, type AgentCommand, type CommandContext, type Tty } from './commands.js';

// Tools and extensions.
export { ALL_TOOLS, LITE_TOOLS, type TodoItem, type ToolContext, type ToolDef } from './tools/index.js';
export { clip, obj, tool, type ToolOutput } from './tools/types.js';
export * from './ext/library.js';
export { McpHub, MCP_KEY, mcpTokenName, type McpServerConfig } from './ext/mcp.js';
