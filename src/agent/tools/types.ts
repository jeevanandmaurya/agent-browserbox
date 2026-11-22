import type { KernelCore as Kernel } from '@/kernel/kernel';
import type { Capability } from '@/kernel/perms';
import type { Shell } from '@/shell/shell';
import type { JsonSchema } from '../types';

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

/** What a tool can reach while it runs. */
export interface ToolContext {
  os: Kernel;
  /** The agent's own shell; its cwd is the base for relative paths. */
  shell: Shell;
  signal: AbortSignal;
  /** The agent's process id; children (sandboxes) are attributed to it. */
  pid: number;
  /** Resolve a model-supplied path inside the virtual filesystem. */
  path(p: string): string;
  /** Ask the human a question and wait for the answer. */
  ask(question: string, options?: string[]): Promise<string>;
  /** Streams partial output of a running tool to the UI. */
  progress(chunk: string): void;
  setTodos(items: TodoItem[]): void;
  /** Runs a nested agent (optionally a named custom agent) to completion and returns its final answer. */
  spawnAgent(task: string, agent?: string): Promise<string>;
}

export interface ToolDef<I = Record<string, unknown>> {
  name: string;
  description: string;
  input_schema: JsonSchema;
  /**
   * The capability this call needs, or null when it is harmless. Receives the
   * input so a tool can be free in the agent's workspace and gated outside it.
   */
  cap(input: I, tc: ToolContext): Capability | null;
  /** One-line description of this call for the UI and the permission prompt. */
  describe(input: I): string;
  run(input: I, tc: ToolContext): Promise<string>;
}

/** Helper that keeps each tool's input type attached to its implementation. */
export function tool<I>(def: ToolDef<I>): ToolDef {
  return def as unknown as ToolDef;
}

export const obj = (properties: JsonSchema['properties'], required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

const MAX_RESULT = 30_000;

/** Keeps tool output within a sane context budget, preserving both ends. */
export function clip(text: string, max = MAX_RESULT): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n\n… [${text.length - max} characters omitted] …\n\n${text.slice(text.length - (max - head))}`;
}

// Packages can provide agent tools.
declare module '@/kernel/package-types' {
  interface PackageModule {
    tools?: ToolDef[];
  }
}
