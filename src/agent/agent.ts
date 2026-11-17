import type { KernelCore as Kernel } from '@/kernel/kernel';
import { AGENT_HOME } from '@/kernel/paths';
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
import { loadExtensions, type Extension } from './ext/library';
import { ProviderError, type Block, type ContextReport, type Msg, type Provider, type Usage } from './types';

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
  | { type: 'usage'; usage: Usage; total: Usage; model: string; context: { used: number; window: number } }
  | { type: 'compact'; before: number; after: number; auto: boolean }
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
/** Fraction of the context window at which the conversation is summarised automatically. */
const AUTO_COMPACT_AT = 0.85;
const COMPACT_PROMPT = `Your context window is nearly full, so this conversation is about to be replaced by a summary that you write now. Do not call any tools. Write the summary for yourself to continue from, covering:
1. What the user asked for, in their words where it matters, including constraints and preferences.
2. What has been done so far: files created or changed (with paths), commands run and their outcomes, decisions made and why.
3. What is in progress right now and the exact next step.
4. Anything learned that must not be lost: errors hit and how they were resolved, facts about the environment, open questions.
Be specific and complete rather than brief; anything left out is forgotten.`;
const CONTINUATION = 'This session continues an earlier conversation that was compacted to free up context. Summary of everything so far:';

export class Agent {
  /** What the model sees. Replaced by a summary when the conversation is compacted. */
  messages: Msg[] = [];
  /** The full conversation for display and saving; never shortened. */
  transcript: Msg[] = [];
  todos: TodoItem[] = [];
  readonly total: Usage = { input: 0, output: 0, cacheRead: 0 };
  readonly proc: Proc;
  readonly shell: Shell;
  readonly id: string;
  #run: AbortController | null = null;
  #system: string | null = null;
  #depth: number;
  #persona: Extension | null;
  #tools: ToolDef[] = [];
  #window = 0;
  /** Context size after the last model call, as reported by the model (0 = unknown). */
  #lastContext = 0;
  #compactions = 0;

  constructor(
    private os: Kernel,
    private host: AgentHost,
    opts: { ppid?: number; depth?: number; id?: string; persona?: Extension } = {},
  ) {
    this.#depth = opts.depth ?? 0;
    this.#persona = opts.persona ?? null;
    this.id = opts.id ?? `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
    this.proc = os.procs.spawn({ name: this.#persona ? `agent:${this.#persona.name}` : this.#depth ? 'sub-agent' : 'agent', kind: 'agent', ppid: opts.ppid, detail: 'idle', onKill: () => this.#run?.abort() });
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
    const last = this.transcript.findLast((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text'));
    return last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') ?? '';
  }

  /** Sends a user message and runs the agent until it stops. Never rejects. */
  async send(text: string): Promise<void> {
    if (this.busy) return;
    const run = (this.#run = new AbortController());
    const emit = (e: AgentEvent) => this.host.onEvent(e);
    const started = performance.now();
    const cfg = loadConfig(this.os);
    this.os.procs.update(this.proc.pid, { state: 'running', detail: describeModel(cfg) });
    const wake = await navigator.wakeLock?.request('screen').catch(() => null);
    let reason: Extract<AgentEvent, { type: 'done' }>['reason'] = 'end';

    try {
      const provider = await createProvider(this.os, cfg);
      const lite = provider.id === 'webllm';
      const allowed = this.#persona?.tools.length ? new Set(this.#persona.tools) : null;
      const tools = [...(lite ? LITE_TOOLS : ALL_TOOLS), ...(lite ? [] : await this.os.mcp.tools())]
        .filter((t) => this.#depth === 0 || !['spawn_agent', 'ask_user'].includes(t.name))
        .filter((t) => !allowed || allowed.has(t.name));
      this.#tools = tools;
      this.#window = provider.contextWindow;
      this.#system ??= await buildSystemPrompt(this.os, cfg, { lite, subagent: this.#depth > 0, persona: this.#persona });
      emit({ type: 'start', model: describeModel(cfg) });
      // Compact before taking on new work, so the new request itself is never summarised away.
      if (cfg.autoCompact && this.#nearlyFull()) await this.#compact(provider, run.signal, emit, true, false);
      this.#push({ role: 'user', content: [{ type: 'text', text }] });

      for (let step = 0; ; step++) {
        if (step >= cfg.maxSteps) {
          emit({ type: 'note', text: `Stopped after ${cfg.maxSteps} steps (the limit in Settings → Model). Send a message to continue.` });
          reason = 'max_steps';
          break;
        }
        const result = await this.#turn(provider, tools, run.signal, emit);
        this.#push({ role: 'assistant', content: result.content, raw: result.raw });
        for (const k of ['input', 'output', 'cacheRead'] as const) this.total[k] += result.usage[k];
        this.#lastContext = result.usage.input + result.usage.cacheRead + result.usage.output;
        emit({ type: 'usage', usage: result.usage, total: { ...this.total }, model: result.model, context: { used: this.#used(), window: this.#window } });

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
        this.#push({ role: 'user', content: results });
        if (cfg.autoCompact && this.#nearlyFull()) await this.#compact(provider, run.signal, emit, true, true);
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
      this.os.procs.update(this.proc.pid, { state: 'idle', detail: `${this.transcript.length} messages` });
      emit({ type: 'done', reason });
    }
  }

  #push(msg: Msg): void {
    this.messages.push(msg);
    this.transcript.push(msg);
  }

  /** Forgets the conversation (the session and its process stay). */
  reset(): void {
    this.messages = [];
    this.transcript = [];
    this.#lastContext = 0;
  }

  #parts(): ContextReport['parts'] {
    const est = (s: string) => this.os.kcore.estimateTokens(s);
    const parts = { system: est(this.#system ?? ''), tools: est(JSON.stringify(this.#tools.map((t) => [t.name, t.description, t.input_schema]))), user: 0, assistant: 0, toolCalls: 0, toolResults: 0 };
    for (const m of this.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_use') parts.toolCalls += est(JSON.stringify(b.input)) + 8;
        else if (b.type === 'tool_result') parts.toolResults += est(b.content) + 8;
        else if (m.role === 'user') parts.user += est(b.text);
        else parts.assistant += est(b.text);
      }
    }
    return parts;
  }

  #used(): number {
    return this.#lastContext || Object.values(this.#parts()).reduce((a, b) => a + b, 0);
  }

  #nearlyFull(): boolean {
    return this.#window > 0 && this.messages.length > 1 && this.#used() > this.#window * AUTO_COMPACT_AT;
  }

  /** Where the context window is going right now. */
  context(): ContextReport {
    const cfg = loadConfig(this.os);
    return { window: this.#window, used: this.#used(), reported: this.#lastContext > 0, parts: this.#parts(), messages: this.messages.length, compactions: this.#compactions, autoCompactAt: cfg.autoCompact ? AUTO_COMPACT_AT : 0 };
  }

  /** Summarises the conversation on request. Resolves false when there was nothing to do or it failed. */
  async compact(): Promise<boolean> {
    if (this.busy) throw new Error('the agent is busy');
    const run = (this.#run = new AbortController());
    const emit = (e: AgentEvent) => this.host.onEvent(e);
    this.os.procs.update(this.proc.pid, { state: 'running', detail: 'compacting' });
    try {
      const cfg = loadConfig(this.os);
      const provider = await createProvider(this.os, cfg);
      this.#window = provider.contextWindow;
      return await this.#compact(provider, run.signal, emit, false, false);
    } catch (err) {
      if (!run.signal.aborted) emit({ type: 'error', message: err instanceof ProviderError ? err.message : `Could not compact: ${(err as Error)?.message ?? err}` });
      return false;
    } finally {
      this.#run = null;
      this.os.procs.update(this.proc.pid, { state: 'idle', detail: `${this.transcript.length} messages` });
      emit({ type: 'done', reason: 'end' });
    }
  }

  /**
   * Replaces the model's view of the conversation with a summary it writes
   * itself. The request reuses the same system prompt and tools, so it is
   * served from the prompt cache. The full transcript is kept for display.
   */
  async #compact(provider: Provider, signal: AbortSignal, emit: (e: AgentEvent) => void, auto: boolean, midTask: boolean): Promise<boolean> {
    if (this.messages.length < 2 || !this.#system) return false;
    emit({ type: 'status', text: 'Compacting the conversation to free up context…' });
    const before = this.#used();
    const history = provider.contextBudget ? fitContext(this.os, this.messages, provider.contextBudget) : this.messages;
    const result = await provider.turn({
      system: this.#system,
      messages: [...history, { role: 'user', content: [{ type: 'text', text: COMPACT_PROMPT }] }],
      tools: this.#tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      signal,
      onText: () => undefined,
      onThinking: () => undefined,
      onStatus: () => undefined,
    });
    for (const k of ['input', 'output', 'cacheRead'] as const) this.total[k] += result.usage[k];
    const summary = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    emit({ type: 'status', text: '' });
    if (!summary) {
      emit({ type: 'note', text: 'Compaction failed: the model returned no summary. The conversation was left as it is.' });
      return false;
    }
    this.messages = [{ role: 'user', content: [{ type: 'text', text: `${CONTINUATION}\n\n${summary}${midTask ? '\n\nContinue the task from where you left off. Do not redo finished work.' : ''}` }] }];
    this.#lastContext = 0;
    this.#compactions++;
    const after = this.#used();
    this.transcript.push({ role: 'assistant', content: [{ type: 'server_note', text: `Conversation compacted: about ${before.toLocaleString()} → ${after.toLocaleString()} tokens` }] });
    emit({ type: 'compact', before, after, auto });
    return true;
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
      spawnAgent: (task, agent) => this.#spawn(task, agent, signal, (chunk) => emit({ type: 'tool_progress', id, chunk })),
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

  async #spawn(task: string, agentName: string | undefined, signal: AbortSignal, progress: (chunk: string) => void): Promise<string> {
    let persona: Extension | undefined;
    if (agentName) {
      const agents = (await loadExtensions(this.os, 'agent')).filter((a) => a.enabled);
      persona = agents.find((a) => a.name === agentName);
      if (!persona) throw new Error(`No agent named "${agentName}". Available: ${agents.map((a) => a.name).join(', ') || 'none'}`);
    }
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
      { ppid: this.proc.pid, depth: this.#depth + 1, persona },
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
    if (calls.length) this.#push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'Interrupted before this tool ran.', is_error: true })) });
  }
}
