import type { KernelCore as Kernel } from './host/os.js';
import { quote, Shell } from './host/os.js';

/**
 * Hooks: commands the user sets up that run at points in the agent's work, as
 * in Claude Code. They live in the setting `agent.hooks`, which no tool can
 * write, so the agent cannot give itself hooks.
 *
 * A hook runs in the box's shell, in the agent's folder, in a shell of its own.
 * What it is about is substituted into the command before it runs:
 *   $BBX_EVENT  the event          $BBX_TOOL  the tool (tool events)
 *   $BBX_FILE   the file a file tool works on
 *   $BBX_INPUT  a JSON file with everything: event, tool, input, result, prompt
 * Exit codes: 0 = fine (its output is added for PostToolUse, UserPromptSubmit
 * and SessionStart); 2 = block, its output is the reason the model sees;
 * anything else = the hook failed: the user is told, the work goes on.
 */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SubagentStop' | 'SessionStart';
export const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart'];
export const HOOKS_KEY = 'agent.hooks';

export interface Hook {
  id: string;
  event: HookEvent;
  /** Tool events: which tools, e.g. `edit_file|write_file`, `shell`, `*` (globs allowed). Empty = all. */
  matcher?: string;
  command: string;
  /** Seconds (default 60). */
  timeout?: number;
  enabled: boolean;
}

export interface HookPayload {
  tool?: string;
  input?: Record<string, unknown>;
  result?: string;
  prompt?: string;
  file?: string;
}

/** One hook that ran, for the chat. */
export interface HookRun {
  event: HookEvent;
  command: string;
  code: number;
  ms: number;
  output: string;
}

export interface HookOutcome {
  /** A hook exited with 2: the reason (tool blocked, message blocked, or "keep going" for Stop). */
  blocked?: string;
  /** Output of hooks that exited 0, to add as context. */
  context: string[];
  runs: HookRun[];
}

export function loadHooks(os: { settings: { get<T>(key: string, fallback: T): T } }): Hook[] {
  const list = os.settings.get<unknown>(HOOKS_KEY, []);
  return Array.isArray(list) ? list.filter((h): h is Hook => !!h && typeof h.command === 'string' && h.command.trim() !== '' && HOOK_EVENTS.includes(h.event)) : [];
}

/** Whether `matcher` (alternatives with `|`, `*` wildcards) covers `tool`. */
export function matchesTool(matcher: string | undefined, tool: string | undefined): boolean {
  if (!matcher?.trim() || matcher.trim() === '*') return true;
  if (!tool) return false;
  return matcher.split('|').some((m) => new RegExp(`^${m.trim().replace(/[.+^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(tool));
}

const MAX_OUTPUT = 8000;
let nextInput = 1;

/** Runs the hooks for `event` in order; the first that blocks stops the rest. */
export async function runHooks(os: Kernel, event: HookEvent, payload: HookPayload, opts: { cwd: string; signal?: AbortSignal; hooks?: Hook[] }): Promise<HookOutcome> {
  const outcome: HookOutcome = { context: [], runs: [] };
  const hooks = (opts.hooks ?? loadHooks(os)).filter((h) => h.enabled && h.event === event && (event === 'PreToolUse' || event === 'PostToolUse' ? matchesTool(h.matcher, payload.tool) : true));
  if (!hooks.length) return outcome;
  const inputFile = `/tmp/bbx-hook-${Date.now()}-${nextInput++}.json`;
  await os.fs.writeFile(inputFile, JSON.stringify({ event, ...payload }));
  try {
    for (const hook of hooks) {
      const vars: Record<string, string> = { BBX_EVENT: event, BBX_TOOL: payload.tool ?? '', BBX_FILE: payload.file ?? '', BBX_INPUT: inputFile };
      // ${NAME} and $NAME, quoted so a path with spaces stays one word.
      const line = hook.command.replace(/\$\{(BBX_[A-Z]+)\}|\$(BBX_[A-Z]+)\b/g, (m, a?: string, b?: string) => (vars[(a ?? b)!] !== undefined ? quote(vars[(a ?? b)!]!) : m));
      const shell = new Shell(os, { cwd: opts.cwd });
      const timeout = AbortSignal.timeout(Math.max(1, hook.timeout ?? 60) * 1000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let out = '';
      let err = '';
      const t0 = performance.now();
      let code: number;
      try {
        code = await shell.run(line, { out: (t) => (out += t), err: (t) => (err += t), signal });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        code = timeout.aborted ? 124 : 1;
        err += timeout.aborted ? `\n(timed out after ${hook.timeout ?? 60} s)` : `\n${(e as Error).message}`;
      } finally {
        shell.close();
      }
      const text = (code === 0 ? out : err.trim() || out).trim().slice(0, MAX_OUTPUT);
      outcome.runs.push({ event, command: hook.command, code, ms: performance.now() - t0, output: text });
      if (code === 2) {
        outcome.blocked = text || `blocked by the hook: ${hook.command}`;
        break;
      }
      if (code === 0 && text) outcome.context.push(text);
    }
  } finally {
    await os.fs.rm(inputFile).catch(() => undefined);
  }
  return outcome;
}
