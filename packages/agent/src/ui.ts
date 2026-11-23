/**
 * @jeevanand/agent-browserbox/ui: what an app's windows need around the agent
 * (model settings, sessions, extensions, diffs, connectors, the in-browser
 * model store, and the types), without the agent loop itself, which runs
 * where the app puts it (the BrowserBox app runs it in a worker).
 */
export * from './config.js';
export { deleteSession, listSessions, loadSession, saveSession, titleFrom, type SessionFile, type SessionInfo } from './session.js';
export { diffFiles, type FileDiff } from './diff.js';
export * from './ext/library.js';
export { MCP_KEY, mcpTokenName, type McpServerConfig } from './ext/mcp.js';
export * from './providers/webllm-store.js';
export { MODE_TAG } from './mode.js';
export { ProviderError, type Block, type ContextReport, type JsonSchema, type Msg, type ToolSpec, type Usage } from './types.js';
export { AGENT_HOME, HOME } from './host/paths.js';
export { VERSION } from './version.js';
export { isImagePath, MAX_IMAGE_BYTES } from './images.js';
export { createProject, defaultFolder, GENERAL, GENERAL_ID, getProject, loadProjects, PROJECTS_DIR, PROJECTS_KEY, removeProject, updateProject, type Project } from './projects.js';
export { addMemory, autoMemory, entries as memoryEntries, MEMORY_AUTO_KEY, MEMORY_BUDGET, memoryPath, readMemory, removeMemory, replaceMemory, type MemoryScope } from './memory.js';
export { HOOK_EVENTS, HOOKS_KEY, loadHooks, type Hook, type HookEvent } from './hooks.js';
export { decide, describeRule, loadRules, matches, RULES_KEY, saveRules, splitCommand, type PermRule, type RuleAction, type RuleScope } from './rules.js';
export type { AgentEvent, AgentHost, TurnStats } from './agent.js';
export type { AgentHandle, AgentInfo, AgentSnapshot, AgentsApi, TurnChanges } from './api.js';
export type { TodoItem } from './tools/types.js';
export type { FilesLike, SettingsApi, WithFiles, WithSettings } from './host/os.js';
