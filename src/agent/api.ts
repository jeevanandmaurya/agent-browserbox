import type { Kernel } from '@/kernel/api';
import type { Prompter } from '@/kernel/perms';
import type { AgentEvent } from './agent';
import type { FileDiff } from './diff';
import type { McpHub } from './ext/mcp';
import type { TodoItem } from './tools/types';
import type { ContextReport, Msg, Usage } from './types';

/**
 * The agent service's public surface. The agent is not part of the kernel: it
 * is a service that runs in the kernel's worker and adds itself to the
 * `Kernel` interface here, by module augmentation. A runtime without it (the
 * SDK's headless runtime, for one) simply has no `agents`.
 */

export interface AgentSnapshot {
  sid: string;
  private: boolean;
  pid: number;
  busy: boolean;
  title: string;
  /** The full conversation (never shortened by compaction). */
  messages: Msg[];
  todos: TodoItem[];
  total: Usage;
  context: ContextReport;
  /** What each file tool call changed, by tool call id. */
  diffs: Record<string, FileDiff>;
}

/** The files one turn changed, with their content before (null: created by the agent, or binary/too large). */
export interface TurnChanges {
  /** Transcript index of the user message that started the turn. */
  turn: number;
  at: number;
  files: Array<{ path: string; before: string | null; existed: boolean; binary: boolean; skipped: boolean }>;
}

export interface AgentInfo {
  sid: string;
  pid: number;
  busy: boolean;
  title: string;
}

/** A window's view of an agent session that lives in the kernel. */
export interface AgentHandle {
  readonly sid: string;
  readonly pid: number;
  /** Resolves when the agent has finished responding. `plan`: look, change nothing, answer with a plan. */
  send(text: string, opts?: { plan?: boolean }): Promise<void>;
  /** Back to just before the user message at transcript index `index`; with `files`, undoing the agent's file changes since. */
  rewind(index: number, files: boolean): Promise<{ restored: string[]; skipped: string[] }>;
  /** The files each turn changed (file tools only). */
  changes(): Promise<TurnChanges[]>;
  stop(): void;
  snapshot(): Promise<AgentSnapshot>;
  /** Where the context window is going. */
  context(): Promise<ContextReport>;
  /** Summarise the conversation now to free context. Resolves false if nothing was done. */
  compact(): Promise<boolean>;
  onEvent(fn: (e: AgentEvent) => void): () => void;
  /** Supplies answers to the agent's ask_user questions. */
  onAsk(fn: (question: string, options?: string[]) => Promise<string>): void;
  /** Overrides the permission dialog for this session (e.g. a terminal y/n prompt). */
  prompter?: Prompter;
  /** Stop observing. The session keeps running in the kernel. */
  detach(): void;
  /** End the session and its process. */
  dispose(): void;
}

export interface AgentsApi {
  /** `resume` loads a saved session file by id. */
  create(opts?: { resume?: string; ppid?: number; private?: boolean }): Promise<AgentHandle>;
  attach(sid: string): Promise<AgentHandle>;
  /** Sessions currently alive in the kernel, most recent first. */
  live(): Promise<AgentInfo[]>;
  /** Lists models on an OpenAI-compatible server, using the stored API key if any. */
  probeModels(baseUrl: string, kind?: 'local' | 'openai'): Promise<string[]>;
  /** Connects to a configured MCP server and lists its tools. */
  probeMcp(name: string): Promise<Array<{ name: string; description: string }>>;
}


declare module '@/kernel/api' {
  interface Kernel {
    readonly agents: AgentsApi;
  }
}

declare module '@/kernel/kernel' {
  interface KernelCore {
    /** Installed by `installAgents` (src/agent/service.ts). */
    agents: AgentsApi;
    /** Connections to remote MCP servers (connectors). */
    mcp: McpHub;
  }
}

export type { Kernel };
