import { AGENT_HOME, type Kernel } from '@/kernel/kernel';
import type { Prompter } from '@/kernel/perms';
import type { Proc } from '@/kernel/proc';
import { resolve } from '@/kernel/vfs/path';
import { registerCommands } from '@/shell/index';
import { Shell } from '@/shell/shell';
import { describeModel, loadConfig } from './config';
import { buildSystemPrompt } from './prompt';
import { createProvider } from './providers/index';
import { validate } from './schema';
import { ALL_TOOLS, LITE_TOOLS, type TodoItem, type ToolContext, type ToolDef } from './tools/index';
import { ProviderError, type Block, type Msg, type Provider, type Usage } from './types';

export type AgentEvent =
  | { type: 'start'; model: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'status'; text: string }
  | { type: 'note'; text: string }
  | { type: 'tool_start'; id: string; name: string; summary: string; input: Record<string, unknown> }
  | { type: 'tool_progress'; id: string; chunk: string }
  | { type: 'tool_end'; id: string; result: string; isError: boolean; ms: number }
  | { type: 'todos'; items: TodoItem[] }
  | { type: 'usage'; usage: Usage; total: Usage; model: string }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: 'end' | 'stopped' | 'error' | 'max_steps' };

/** How an agent talks to whatever is hosting it (the GUI app, the CLI, a parent agent). */
export interface AgentHost {
  onEvent(e: AgentEvent): void;
  ask(question: string, options?: string[]): Promise<string>;
  /** Overrides the OS permission dialog, e.g. with a y/n prompt in the terminal. */
  prompter?: Prompter;
}

type ToolUse = Extract<Block, { type: 'tool_use' }>;
type ToolResult = Extract<Block, { type: 'tool_result' }>;

const estimate = (os: Kernel, m: Msg) => m.content.reduce((n, b) => n + os.kcore.estimateTokens(b.type === 'tool_use' ? JSON.stringify(b.input) : b.type === 'tool_result' ? b.content : b.text), 8);

/** For small-context providers: blank out old tool output, then drop the oldest turns. */
function fitContext(os: Kernel, messages: Msg[], budget: number): Msg[] {
  const total = (ms: Msg[]) => ms.reduce((n, m) => n + estimate(os, m), 0);
  if (total(messages) <= budget) return messages;
  let out = messages.map((m, i) =>
    i >= messages.length - 4 ? m : { ...m, raw: undefined, content: m.content.map((b) => (b.type === 'tool_result' && b.content.length > 200 ? { ...b, content: '[earlier output elided to save context]' } : b)) },
  );
  while (out.length > 4 && total(out) > budget) {
    // Drop from the front up to the next plain user message so tool calls and their results stay paired.
    const next = out.findIndex((m, i) => i > 0 && m.role === 'user' && !m.content.some((b) => b.type === 'tool_result'));
    if (next <= 0) break;
    out = out.slice(next);
  }
  return out;
}

/**
 * One agent session: a conversation plus the loop that lets the model act
 * through tools. It is a process — visible in the Task Manager and killable.
 */
export class Agent {
  messages: Msg[] = [];
  todos: TodoItem[] = [];
  readonly total: Usage = { input: 0, output: 0, cacheRead: 0 };
  readonly proc: Proc;
  readonly shell: Shell;
  readonly id: string;
  #run: AbortController | null = null;
  #system: string | null = null;
  #depth: number;

  constructor(
    private os: Kernel,
    private host: AgentHost,
    opts: { ppid?: number; depth?: number; id?: string } = {},
  ) {
    this.#depth = opts.depth ?? 0;
    this.id = opts.id ?? `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
    this.proc = os.procs.spawn({ name: this.#depth ? 'sub-agent' : 'agent', kind: 'agent', ppid: opts.ppid, detail: 'idle', onKill: () => this.#run?.abort() });
    os.procs.update(this.proc.pid, { state: 'idle' });
    this.shell = registerCommands(new Shell(os, { cwd: AGENT_HOME, ppid: this.proc.pid }));
  }

  get busy(): boolean {
    return this.#run !== null;
  }

  stop(): void {
    this.#run?.abort();
  }

  dispose(): void {
    this.stop();
    this.os.procs.exit(this.proc.pid);
  }

  /** Text of the last assistant turn. */
  lastText(): string {
    const last = this.messages.findLast((m) => m.role === 'assistant');
    return last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') ?? '';
  }

  /** Sends a user message and runs the agent until it stops. Never rejects. */
  async send(text: string): Promise<void> {
    if (this.busy) return;
    const run = (this.#run = new AbortController());
    const emit = (e: AgentEvent) => this.host.onEvent(e);
    const started = performance.now();
    const cfg = loadConfig(this.os);
    this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    this.os.procs.update(this.proc.pid, { state: 'running', detail: describeModel(cfg) });
    const wake = await navigator.wakeLock?.request('screen').catch(() => null);
    let reason: Extract<AgentEvent, { type: 'done' }>['reason'] = 'end';

    try {
      const provider = await createProvider(this.os, cfg);
      const lite = provider.id === 'webllm';
      const tools = (lite ? LITE_TOOLS : ALL_TOOLS).filter((t) => this.#depth === 0 || !['spawn_agent', 'ask_user'].includes(t.name));
      this.#system ??= await buildSystemPrompt(this.os, cfg, { lite, subagent: this.#depth > 0 });
      emit({ type: 'start', model: describeModel(cfg) });

      for (let step = 0; ; step++) {
        if (step >= cfg.maxSteps) {
          emit({ type: 'note', text: `Stopped after ${cfg.maxSteps} steps (the limit in Settings → Model). Send a message to continue.` });
          reason = 'max_steps';
          break;
        }
        const result = await this.#turn(provider, tools, run.signal, emit);
        this.messages.push({ role: 'assistant', content: result.content, raw: result.raw });
        for (const k of ['input', 'output', 'cacheRead'] as const) this.total[k] += result.usage[k];
        emit({ type: 'usage', usage: result.usage, total: { ...this.total }, model: result.model });

        if (result.stop === 'pause') continue;
        if (result.stop === 'refusal') {
          emit({ type: 'note', text: 'The model declined to continue with this request.' });
          break;
        }
        const calls = result.content.filter((b): b is ToolUse => b.type === 'tool_use');
        if (!calls.length) {
          if (result.stop === 'max_tokens') emit({ type: 'note', text: 'The reply hit the output limit and was cut off. Ask the agent to continue.' });
          break;
        }
        // A truncated turn can leave a tool input half-written; never run it.
        const results =
          result.stop === 'max_tokens'
            ? calls.map((c): ToolResult => ({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: 'Your output was cut off before this tool call was complete, so it was not run. Retry with a smaller input (for example, write large files in several parts).' }))
            : await this.#runTools(calls, tools, run.signal, emit);
        this.messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      if (run.signal.aborted) reason = 'stopped';
      else {
        reason = 'error';
        if (!(err instanceof ProviderError)) console.error('[agent]', err);
        emit({ type: 'error', message: err instanceof ProviderError ? err.message : `Unexpected error: ${(err as Error)?.message ?? err}` });
      }
      this.#repairHistory();
    } finally {
      this.#run = null;
      void wake?.release().catch(() => undefined);
      this.os.procs.account(this.proc.pid, performance.now() - started);
      this.os.procs.update(this.proc.pid, { state: 'idle', detail: `${this.messages.length} messages` });
      emit({ type: 'done', reason });
    }
  }

  #turn(provider: Provider, tools: ToolDef[], signal: AbortSignal, emit: (e: AgentEvent) => void) {
    return provider.turn({
      system: this.#system!,
      messages: provider.contextBudget ? fitContext(this.os, this.messages, provider.contextBudget) : this.messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      signal,
      onText: (delta) => emit({ type: 'text', delta }),
      onThinking: (delta) => emit({ type: 'thinking', delta }),
      onStatus: (text) => emit({ type: 'status', text }),
    });
  }

  async #runTools(calls: ToolUse[], tools: ToolDef[], signal: AbortSignal, emit: (e: AgentEvent) => void): Promise<ToolResult[]> {
    const tc = (id: string): ToolContext => ({
      os: this.os,
      shell: this.shell,
      signal,
      pid: this.proc.pid,
      path: (p) => resolve(this.shell.cwd, String(p).replace(/^~(?=\/|$)/, this.shell.env.HOME ?? '')),
      ask: async (q, options) => {
        this.os.procs.update(this.proc.pid, { state: 'blocked' });
        try {
          return await this.host.ask(q, options);
        } finally {
          this.os.procs.update(this.proc.pid, { state: 'running' });
        }
      },
      progress: (chunk) => emit({ type: 'tool_progress', id, chunk }),
      setTodos: (items) => {
        this.todos = items;
        emit({ type: 'todos', items });
      },
      spawnAgent: (task) => this.#spawn(task, signal, (chunk) => emit({ type: 'tool_progress', id, chunk })),
    });

    const one = async (call: ToolUse): Promise<ToolResult> => {
      const started = performance.now();
      const fail = (content: string): ToolResult => ({ type: 'tool_result', tool_use_id: call.id, content, is_error: true });
      const def = tools.find((t) => t.name === call.name);
      let summary = call.name;
      let announced = false;
      let out: ToolResult;
      if (!def) out = fail(`Unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(', ')}`);
      else if (call.invalid !== undefined) out = fail(JSON.stringify({ INVALID_JSON: call.invalid }));
      else {
        const problems = validate(def.input_schema, call.input);
        if (problems.length) out = fail(`Invalid input for ${call.name}: ${problems.join('; ')}`);
        else {
          const ctx = tc(call.id);
          summary = def.describe(call.input);
          emit({ type: 'tool_start', id: call.id, name: call.name, summary, input: call.input });
          announced = true;
          try {
            const cap = def.cap(call.input, ctx);
            let allowed = true;
            if (cap) {
              this.os.procs.update(this.proc.pid, { state: 'blocked' });
              allowed = await this.os.perms.request({ cap, actor: 'The agent', title: call.name, detail: summary }, this.host.prompter);
              this.os.procs.update(this.proc.pid, { state: 'running' });
            }
            signal.throwIfAborted();
            out = allowed ? { type: 'tool_result', tool_use_id: call.id, content: await def.run(call.input, ctx) } : fail('The user denied permission for this action.');
          } catch (err) {
            if (signal.aborted) throw err;
            out = fail((err as Error)?.message || String(err));
          }
        }
      }
      if (!announced) emit({ type: 'tool_start', id: call.id, name: call.name, summary, input: call.input });
      emit({ type: 'tool_end', id: call.id, result: out.content, isError: out.is_error ?? false, ms: performance.now() - started });
      return out;
    };

    // Harmless calls (reads, searches) run concurrently; anything gated runs in order.
    const parallel = calls.every((c) => {
      const def = tools.find((t) => t.name === c.name);
      try {
        return def !== undefined && c.invalid === undefined && def.cap(c.input, tc(c.id)) === null && !['ask_user', 'spawn_agent', 'todo_write'].includes(c.name);
      } catch {
        return false;
      }
    });
    if (parallel) return Promise.all(calls.map(one));
    const results: ToolResult[] = [];
    for (const c of calls) results.push(await one(c));
    return results;
  }

  async #spawn(task: string, signal: AbortSignal, progress: (chunk: string) => void): Promise<string> {
    const child = new Agent(
      this.os,
      {
        onEvent: (e) => {
          if (e.type === 'tool_start') progress(`▸ ${e.name}: ${e.summary.split('\n')[0]!.slice(0, 100)}\n`);
          else if (e.type === 'error') progress(`error: ${e.message}\n`);
        },
        ask: async () => 'Sub-agents cannot ask the user. Use your best judgement and note the assumption in your report.',
        prompter: this.host.prompter,
      },
      { ppid: this.proc.pid, depth: this.#depth + 1 },
    );
    const abort = () => child.stop();
    signal.addEventListener('abort', abort);
    try {
      await child.send(task);
      signal.throwIfAborted();
      return child.lastText() || '(the sub-agent produced no report)';
    } finally {
      signal.removeEventListener('abort', abort);
      child.dispose();
    }
  }

  /** After an interruption, answer any dangling tool calls so the transcript stays valid. */
  #repairHistory(): void {
    const last = this.messages.at(-1);
    if (last?.role !== 'assistant') return;
    const calls = last.content.filter((b): b is ToolUse => b.type === 'tool_use');
    if (calls.length) this.messages.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'Interrupted before this tool ran.', is_error: true })) });
  }
}
