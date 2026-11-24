import type { Prompter } from './host/perms.js';
import type { AgentEvent } from './agent.js';
import type { FileDiff } from './diff.js';
import type { TodoItem } from './tools/types.js';
import type { ContextReport, Msg, Usage } from './types.js';

/** Agent sessions, as an app sees them (AgentManager implements AgentsApi). */

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
  /** The project this chat belongs to. */
  project: string;
  /** What each sub-agent did, by its spawn_agent call id. */
  subagents?: Record<string, Msg[]>;
  /** Works on its own copy (`folder`) of the project folder (`lower`). */
  isolated?: { folder: string; lower: string };
  /**
   * While it works: the current step's events not yet in `messages` (text so
   * far, running tools), for a window that opens the chat mid-turn to replay.
   */
  live?: AgentEvent[];
}

/** The files one turn changed, with their content before (null: created by the agent, or binary/too large). */
export interface TurnChanges {
  /** Transcript index of the user message that started the turn. */
  turn: number;
  at: number;
  files: Array<{ path: string; before: string | null; existed: boolean; binary: boolean; skipped: boolean }>;
}

/** An isolated chat: where its copy is, the folder it copies, and the files it changed (paths inside the copy). */
export interface Isolation {
  folder: string;
  lower: string;
  changes: Array<{ path: string; kind: 'added' | 'modified' | 'deleted' }>;
}

export interface AgentInfo {
  sid: string;
  pid: number;
  busy: boolean;
  /** Waiting for you: an approval or an answer to a question. */
  waiting?: boolean;
  title: string;
  project: string;
}

/** A window's view of an agent session that lives in the kernel. */
export interface AgentHandle {
  readonly sid: string;
  readonly pid: number;
  /** Resolves when the agent has finished responding. `plan`: look, change nothing, answer with a plan. */
  /** `images`: paths of image files in the box for the model to see with the message. */
  /** `again`: retry after an error, answering the conversation as it is (no new message). */
  send(text: string, opts?: { plan?: boolean; images?: string[]; again?: boolean }): Promise<void>;
  /** Back to just before the user message at transcript index `index`; with `files`, undoing the agent's file changes since. */
  rewind(index: number, files: boolean): Promise<{ restored: string[]; skipped: string[] }>;
  /** The files each turn changed (file tools only). */
  changes(): Promise<TurnChanges[]>;
  /** An isolated chat's copy and what it changed in it; null when the chat works in the folder itself. */
  isolation(): Promise<Isolation | null>;
  /** Starts working on a copy of the project folder, or stops (refused while the copy has changes). */
  isolate(on: boolean): Promise<void>;
  /** Copies an isolated chat's changes (all, or under `paths`, relative to the copy) into the folder. Returns the paths applied. */
  applyWork(paths?: string[]): Promise<string[]>;
  /** Throws an isolated chat's changes away (all, or under `paths`). */
  discardWork(paths?: string[]): Promise<void>;
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
  /** `project`: the project a new chat belongs to (default General); a resumed chat keeps its own. */
  /** `isolated`: the new chat works on its own copy of the project folder. */
  create(opts?: { resume?: string; ppid?: number; private?: boolean; project?: string; isolated?: boolean }): Promise<AgentHandle>;
  attach(sid: string): Promise<AgentHandle>;
  /** Sessions currently alive in the kernel, most recent first. */
  live(): Promise<AgentInfo[]>;
  /** Lists the models of an API or a local server, using the stored API key if any. */
  probeModels(baseUrl: string, kind?: 'local' | 'api'): Promise<string[]>;
  /** Connects to a configured MCP server and lists its tools. */
  probeMcp(name: string): Promise<Array<{ name: string; description: string }>>;
}
