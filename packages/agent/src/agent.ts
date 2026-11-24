import { Checkpoints } from './checkpoints.js';
import { diffFiles, type FileDiff } from './diff.js';
import type { KernelCore as Kernel } from './host/os.js';
import type { Prompter } from './host/perms.js';
import type { Proc } from './host/os.js';
import { isInside, resolve } from './host/path.js';
import { listApps } from './host/os.js';
import { Shell } from './host/os.js';
import { describeModel, hasServerWebTools, loadConfig } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { IMAGE_TOKENS, imageRef, withImageData } from './images.js';
import { decide, describeRule, loadRules } from './rules.js';
import { FileMemory } from './seen.js';
import { GENERAL, GENERAL_ID, type Project } from './projects.js';
import { autoMemory, memoryPath, type MemoryScope } from './memory.js';
import { artifactFile } from './artifacts.js';
import { workFolder, workStore } from './session.js';
import { runHooks, type HookEvent, type HookPayload } from './hooks.js';
import { createProvider } from './providers/index.js';
import { validate } from './schema.js';
import { ALL_TOOLS, LITE_TOOLS, type TodoItem, type ToolContext, type ToolDef } from './tools/index.js';
import { loadExtensions, type Extension } from './ext/library.js';
import { ProviderError, type Block, type ContextReport, type Msg, type Provider, type Usage } from './types.js';

/** Timing of one model call. */
export interface TurnStats {
  /** Whole call, ms. */
  ms: number;
  /** Time to the first streamed token, ms. */
  ttft: number;
  /** Output tokens per second while generating. */
  tps: number;
}

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
  | { type: 'usage'; usage: Usage; total: Usage; model: string; context: { used: number; window: number }; stats: TurnStats }
  | { type: 'compact'; before: number; after: number; auto: boolean }
  /** A hook ran (see hooks.ts). */
  | { type: 'hook'; event: HookEvent; command: string; code: number; ms: number; output: string }
  /** A file tool changed a file: what changed. */
  | { type: 'file_change'; id: string; diff: FileDiff }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: 'end' | 'stopped' | 'error' | 'max_steps' };

/** How an agent talks to whatever is hosting it (the GUI app, the CLI, a parent agent). */
export interface AgentHost {
  onEvent(e: AgentEvent): void;
  ask(question: string, options?: string[]): Promise<string>;
  /** Overrides the OS permission dialog, e.g. with a y/n prompt in the terminal. */
  prompter?: Prompter;
}

/** Providers whose models are small: a short system prompt and the reduced tool set. */
const SMALL_MODELS = new Set(['webllm', 'builtin']);

/** Tools that only look: what plan mode allows. */
const PLAN_TOOLS = new Set(['read_artifact', 'read_file', 'view_image', 'list_dir', 'glob', 'grep', 'http_fetch', 'system_info', 'list_processes', 'use_skill', 'ask_user', 'todo_write', 'preview_logs', 'web_search', 'web_fetch']);
/**
 * Tools that change nothing, so several can run at once. Everything else runs
 * in order, even without a permission prompt: two edits of one file at once
 * would each start from the original, and the second would undo the first.
 */
const READ_ONLY = new Set(['read_artifact', 'read_file', 'view_image', 'list_dir', 'glob', 'grep', 'system_info', 'list_processes', 'use_skill', 'preview_logs']);
/** An http_fetch that only reads: what plan mode allows of it. */
const readsOnly = (call: { name: string; input: Record<string, unknown> }) => call.name !== 'http_fetch' || ((call.input.method === undefined || String(call.input.method).toUpperCase() === 'GET') && call.input.save_to === undefined);
const PLAN_NOTE =
  'Plan mode: investigate with read-only tools only, then reply with a short, numbered plan of what you would change and how you would check it (files, commands, tests). Do not make any changes yet: the user will review the plan and tell you to go ahead.';
export { MODE_TAG } from './mode.js';

/** Files a tool call will change, resolved to absolute paths. */
function changedPaths(call: { name: string; input: Record<string, unknown> }, path: (p: string) => string, project = GENERAL_ID, workspace = ''): string[] {
  const i = call.input;
  // Memory files are files: changes to them show as diffs and can be undone.
  if (call.name === 'memory' && i.action !== 'view') return [memoryPath((i.scope as MemoryScope | undefined) ?? 'project', project)];
  // A new version changes the artifact's record; the version file itself is reported as created.
  if (call.name === 'update_artifact' && typeof i.id === 'string') return [artifactFile(workspace, i.id)];
  if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'delete_path') return typeof i.path === 'string' ? [path(i.path)] : [];
  if (call.name === 'move_path') return [i.copy ? null : i.from, i.to].filter((p): p is string => typeof p === 'string').map(path);
  if ((call.name === 'http_fetch' && typeof i.save_to === 'string') || (call.name === 'gpu_compute' && typeof i.output_file === 'string')) return [path((i.save_to ?? i.output_file) as string)];
  return [];
}

/** How many times Stop hooks may send the agent back to work for one message. */
const MAX_STOP_ROUNDS = 3;

/** Seconds between attempts at a model call that failed for a reason that may pass. */
const RETRY_WAITS = [2, 5, 10, 20];

/** Sub-agents that run at the same time. */
const MAX_SUBAGENTS = 4;

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order in the result. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Keeps a diff small enough to send and save. */
function capDiff(d: FileDiff, maxLines = 600): FileDiff {
  let n = 0;
  const hunks = [];
  for (const h of d.hunks) {
    if (n + h.lines.length > maxLines) return { ...d, hunks, note: `Showing the first ${n} lines of the change.` };
    hunks.push(h);
    n += h.lines.length;
  }
  return d;
}

type ToolUse = Extract<Block, { type: 'tool_use' }>;
type ToolResult = Extract<Block, { type: 'tool_result' }>;

const estimate = (os: Kernel, m: Msg) =>
  m.content.reduce(
    (n, b) => n + (b.type === 'image' ? IMAGE_TOKENS : os.kcore.estimateTokens(b.type === 'tool_use' ? JSON.stringify(b.input) : b.type === 'tool_result' ? b.content : b.text) + (b.type === 'tool_result' ? (b.images?.length ?? 0) * IMAGE_TOKENS : 0)),
    8,
  );

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
  /** Image data read during a run, by path; dropped when the run ends. */
  #images = new Map<string, string>();
  /** What the agent has seen of each file (read-before-edit). */
  #seen = new FileMemory();
  #system: string | null = null;
  /** What the system prompt was built for; it is rebuilt when that changes (model kind, instructions). */
  #systemKey = '';
  #depth: number;
  #persona: Extension | null;
  #tools: ToolDef[] = [];
  #window = 0;
  /** Context size after the last model call, as reported by the model (0 = unknown). */
  #lastContext = 0;
  #compactions = 0;
  /** Files as they were before each turn changed them, for undo. */
  readonly checkpoints: Checkpoints;
  /** What each file tool call changed, by tool call id (shown in the chat, kept with the session). */
  diffs: Record<string, FileDiff> = {};
  /** What each sub-agent did, by the spawn_agent call id (its last messages), so the user can read it. */
  subagents: Record<string, Msg[]> = {};
  /** The project this agent works in (General: /home/agent). */
  readonly project: Project;
  /**
   * Isolated: the chat works on its own copy of the project folder (an
   * overlay at /work/<id>); its changes reach the folder when the user applies them.
   */
  isolated = false;
  /** A sub-agent works where its parent does. */
  #folder: string | null;

  /** Where this agent works: the project's folder, or the chat's own copy of it. */
  get folder(): string {
    return this.#folder ?? (this.isolated ? workFolder(this.id) : this.project.folder);
  }

  /**
   * Starts or stops working on a copy of the project folder. Stopping is
   * refused while the copy has changes (apply or discard them first).
   */
  async isolate(on: boolean): Promise<void> {
    if (this.#depth) throw new Error('a sub-agent works where its parent does');
    if (on) await this.os.fs.overlay(workFolder(this.id), this.project.folder, workStore(this.id));
    else if (this.isolated && (await this.os.fs.overlayChanges(workFolder(this.id))).length) throw new Error('this chat has changes that are not applied: apply or discard them first');
    if (on === this.isolated) return;
    const from = this.folder;
    this.isolated = on;
    // The shell follows into (or out of) the copy, keeping its place in it.
    const cwd = this.shell.cwd;
    this.shell.reset();
    this.shell.cwd = isInside(from, cwd) ? this.folder + cwd.slice(from.length) : this.folder;
    this.#system = null;
  }

  /** SessionStart hooks have run for this session (in this process). */
  #started = false;
  /** A model of its own (custom agents, sub-agents): the main provider with this model id. */
  #model: string | null;

  constructor(
    private os: Kernel,
    private host: AgentHost,
    opts: { ppid?: number; depth?: number; id?: string; persona?: Extension; model?: string; project?: Project; folder?: string } = {},
  ) {
    this.#depth = opts.depth ?? 0;
    this.project = opts.project ?? GENERAL;
    // A project can name a default model for its chats; a custom agent's own comes first.
    this.#model = opts.model || this.project.model || null;
    this.#persona = opts.persona ?? null;
    this.id = opts.id ?? `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
    this.proc = os.procs.spawn({ name: this.#persona ? `agent:${this.#persona.name}` : this.#depth ? 'sub-agent' : 'agent', kind: 'agent', ppid: opts.ppid, detail: 'idle', onKill: () => this.#run?.abort() });
    os.procs.update(this.proc.pid, { state: 'idle' });
    this.#folder = opts.folder ?? null;
    this.shell = new Shell(os, { cwd: this.folder });
    this.checkpoints = new Checkpoints(os);
  }

  get busy(): boolean {
    return this.#run !== null;
  }

  stop(): void {
    this.#run?.abort();
  }

  dispose(): void {
    this.stop();
    this.shell.close();
    this.os.procs.exit(this.proc.pid);
  }

  /** Text of the last assistant turn. */
  lastText(): string {
    const last = this.transcript.findLast((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text'));
    return last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') ?? '';
  }

  /**
   * Sends a user message and runs the agent until it stops. Never rejects.
   * `plan`: look but do not change anything, and answer with a plan.
   * `images`: paths of image files in the box for the model to see with the message.
   */
  async send(text: string, opts: { plan?: boolean; images?: string[]; again?: boolean } = {}): Promise<void> {
    if (this.busy) return;
    const run = (this.#run = new AbortController());
    const emit = (e: AgentEvent) => this.host.onEvent(e);
    const started = performance.now();
    const cfg = this.#config();
    this.os.procs.update(this.proc.pid, { state: 'running', detail: describeModel(cfg) });
    const wake = await navigator.wakeLock?.request('screen').catch(() => null);
    let reason: Extract<AgentEvent, { type: 'done' }>['reason'] = 'end';

    try {
      const provider = await createProvider(this.os, cfg);
      // Small on-device models (WebGPU, the browser's own) get the short prompt and the reduced tool set.
      const lite = SMALL_MODELS.has(provider.id);
      const allowed = this.#persona?.tools.length ? new Set(this.#persona.tools) : null;
      // Rebuilt every step: a package the agent installs mid-task adds its tools straight away.
      const toolset = async () =>
        [...(lite ? LITE_TOOLS : ALL_TOOLS), ...(lite ? [] : await this.os.mcp.tools())]
          .filter((t) => t.name !== 'run_python' || this.os.packages.isInstalled('python')) // offered once the python package is installed
          .filter((t) => this.#depth === 0 || !['spawn_agent', 'ask_user'].includes(t.name))
          .filter((t) => t.name !== 'open_app' || listApps().length > 0) // a headless runtime has no apps
          .filter((t) => t.name !== 'preview' || !!this.os.preview) // pages need a window to run in
          .filter((t) => !allowed || allowed.has(t.name))
          .filter((t) => t.name !== 'memory' || autoMemory(this.os)) // the user can turn off memories the agent saves itself
          .filter((t) => !opts.plan || PLAN_TOOLS.has(t.name));
      let tools = (this.#tools = await toolset());
      this.#window = provider.contextWindow;
      await this.#ensureSystem(cfg, lite);
      emit({ type: 'start', model: describeModel(cfg) });
      // Compact before taking on new work, so the new request itself is never summarised away.
      // Tiny in-browser models summarise badly; for them the oldest turns simply drop out of view (see the provider).
      const autoCompact = cfg.autoCompact && !lite;
      if (autoCompact && this.#nearlyFull()) await this.#compact(provider, run.signal, emit, true, false);
      // Hooks: once per session, then for every message. A UserPromptSubmit hook can block the message.
      const hookContext: string[] = [];
      if (!this.#started) {
        this.#started = true;
        hookContext.push(...(await this.#hooks('SessionStart', {}, run.signal, emit)).context);
      }
      if (opts.again) {
        // Retrying: the conversation already ends with what the model has to answer.
        if (this.messages.at(-1)?.role !== 'user') {
          emit({ type: 'note', text: 'There is nothing to retry: the last reply is complete. Send a message to continue.' });
          return;
        }
      } else {
        const submitted = await this.#hooks('UserPromptSubmit', { prompt: text }, run.signal, emit);
        if (submitted.blocked !== undefined) {
          emit({ type: 'note', text: `A hook blocked this message: ${submitted.blocked}` });
          return;
        }
        hookContext.push(...submitted.context);
        this.checkpoints.begin(this.transcript.length);
        const content: Block[] = [{ type: 'text', text: opts.plan ? `${text}\n\n<mode>${PLAN_NOTE}</mode>` : text }];
        if (hookContext.length) content.push({ type: 'text', text: `<hook-context>\n${hookContext.join('\n\n')}\n</hook-context>` });
        for (const path of opts.images ?? []) {
          if (lite) {
            content.push({ type: 'text', text: `(The image ${path} was attached, but this model cannot see images.)` });
            continue;
          }
          try {
            content.push({ type: 'image', ...(await imageRef(this.os, path)) });
          } catch (err) {
            content.push({ type: 'text', text: `(Could not attach the image: ${(err as Error).message}.)` });
          }
        }
        this.#push({ role: 'user', content });
      }

      let stopRounds = 0;
      for (let step = 0; ; step++) {
        if (step >= cfg.maxSteps) {
          emit({ type: 'note', text: `Stopped after ${cfg.maxSteps} steps (the limit in Settings → Model). Send a message to continue.` });
          reason = 'max_steps';
          break;
        }
        if (step > 0) tools = this.#tools = await toolset();
        emit({ type: 'status', text: 'Waiting for the model…' });
        const result = await this.#turnRetrying(provider, tools, run.signal, emit);
        this.#push({ role: 'assistant', content: result.content, raw: result.raw });
        for (const k of ['input', 'output', 'cacheRead'] as const) this.total[k] += result.usage[k];
        this.#lastContext = result.usage.input + result.usage.cacheRead + result.usage.output;
        emit({ type: 'usage', usage: result.usage, total: { ...this.total }, model: result.model, context: { used: this.#used(), window: this.#window }, stats: result.stats });

        if (result.stop === 'pause') continue;
        if (result.stop === 'refusal') {
          emit({ type: 'note', text: 'The model declined to continue with this request.' });
          break;
        }
        const calls = result.content.filter((b): b is ToolUse => b.type === 'tool_use');
        if (!calls.length) {
          if (result.stop === 'max_tokens') emit({ type: 'note', text: 'The reply hit the output limit and was cut off. Ask the agent to continue.' });
          else if (stopRounds < MAX_STOP_ROUNDS) {
            // A Stop hook can send the agent back to work (e.g. "the tests fail: …"), a few times at most.
            const stop = await this.#hooks(this.#depth > 0 ? 'SubagentStop' : 'Stop', { result: this.lastText() }, run.signal, emit);
            if (stop.blocked !== undefined) {
              stopRounds++;
              this.#push({ role: 'user', content: [{ type: 'text', text: `<hook-feedback>\nA Stop hook asks you to keep going:\n${stop.blocked}\n</hook-feedback>` }] });
              continue;
            }
          }
          break;
        }
        // A truncated turn can leave a tool input half-written; never run it.
        if (result.stop === 'max_tokens') emit({ type: 'note', text: 'The reply hit the output limit and was cut off, so its unfinished tool call was not run. The agent was asked to retry in smaller steps.' });
        const results =
          result.stop === 'max_tokens'
            ? calls.map((c): ToolResult => ({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: 'Your output was cut off before this tool call was complete, so it was not run. Retry with a smaller input (for example, write large files in several parts).' }))
            : await this.#runTools(calls, tools, run.signal, emit, opts.plan);
        this.#push({ role: 'user', content: results });
        if (autoCompact && this.#nearlyFull()) await this.#compact(provider, run.signal, emit, true, true);
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
      this.#images.clear();
      void wake?.release().catch(() => undefined);
      this.os.procs.account(this.proc.pid, performance.now() - started);
      this.os.procs.update(this.proc.pid, { state: 'idle', detail: `${this.transcript.length} messages` });
      emit({ type: 'done', reason });
    }
  }

  /**
   * Goes back to just before the user message at transcript index `index`:
   * the conversation from there on is removed, and with `files`, the files the
   * agent changed since then are put back as they were.
   */
  async rewind(index: number, files: boolean): Promise<{ restored: string[]; skipped: string[] }> {
    if (this.busy) throw new Error('Stop the agent first.');
    const msg = this.transcript[index];
    if (!msg || msg.role !== 'user' || !msg.content.some((b) => b.type === 'text')) throw new Error('That is not one of your messages.');
    // The model's view: the same message, unless the conversation was summarised after it.
    let mi = this.messages.indexOf(msg);
    if (mi < 0 && this.messages.length === this.transcript.length) mi = index;
    if (mi < 0) {
      const key = JSON.stringify(msg.content);
      mi = this.messages.findIndex((m) => m.role === 'user' && JSON.stringify(m.content) === key);
    }
    if (mi < 0) throw new Error('The conversation was summarised after this message, so it cannot be rewound to here. Pick a later message.');
    const result = files ? await this.checkpoints.restore(index) : (this.checkpoints.drop(index), { restored: [], skipped: [] });
    this.messages = this.messages.slice(0, mi);
    this.transcript = this.transcript.slice(0, index);
    const ids = new Set(this.transcript.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []))));
    for (const id of Object.keys(this.diffs)) if (!ids.has(id)) delete this.diffs[id];
    for (const id of Object.keys(this.subagents)) if (!ids.has(id)) delete this.subagents[id];
    this.#lastContext = 0;
    return result;
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
        else if (b.type === 'tool_result') parts.toolResults += est(b.content) + 8 + (b.images?.length ?? 0) * IMAGE_TOKENS;
        else if (b.type === 'image') parts.user += IMAGE_TOKENS;
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
    const rolling = cfg.provider === 'webgpu' || cfg.provider === 'builtin';
    return { window: this.#window, used: this.#used(), reported: this.#lastContext > 0, parts: this.#parts(), messages: this.messages.length, compactions: this.#compactions, autoCompactAt: cfg.autoCompact && !rolling ? AUTO_COMPACT_AT : 0, rolling };
  }

  /** Runs the user's hooks for an event, showing each run in the chat. */
  async #hooks(event: HookEvent, payload: HookPayload, signal: AbortSignal, emit: (e: AgentEvent) => void) {
    const outcome = await runHooks(this.os, event, payload, { cwd: this.shell.cwd, signal });
    for (const r of outcome.runs) emit({ type: 'hook', ...r });
    return outcome;
  }

  /** The model configuration, with this agent's own model when it has one (only an API has several). */
  #config(): ReturnType<typeof loadConfig> {
    const cfg = loadConfig(this.os);
    return this.#model && cfg.provider === 'api' ? { ...cfg, apiModel: this.#model } : cfg;
  }

  /**
   * The system prompt, built once and kept while nothing it depends on changes,
   * so the prompt cache keeps working. A different kind of model (an in-browser
   * one gets a shorter prompt), web tools or extra instructions rebuild it.
   */
  async #ensureSystem(cfg: ReturnType<typeof loadConfig>, lite: boolean): Promise<void> {
    const key = JSON.stringify([lite, hasServerWebTools(cfg), cfg.instructions]);
    if (this.#system !== null && key === this.#systemKey) return;
    this.#system = await buildSystemPrompt(this.os, cfg, { lite, subagent: this.#depth > 0, persona: this.#persona, project: this.project, folder: this.folder });
    this.#systemKey = key;
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
      // A resumed session has not built its system prompt yet.
      await this.#ensureSystem(cfg, SMALL_MODELS.has(provider.id));
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
      messages: await withImageData(this.os, [...history, { role: 'user', content: [{ type: 'text', text: COMPACT_PROMPT }] }], this.#images),
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
    // The summary does not hold file contents: files must be read again before editing.
    this.#seen.clear();
    this.messages = [{ role: 'user', content: [{ type: 'text', text: `${CONTINUATION}\n\n${summary}${midTask ? '\n\nContinue the task from where you left off. Do not redo finished work.' : ''}` }] }];
    this.#lastContext = 0;
    this.#compactions++;
    const after = this.#used();
    this.transcript.push({ role: 'assistant', content: [{ type: 'server_note', text: `Conversation compacted: about ${before.toLocaleString()} → ${after.toLocaleString()} tokens` }] });
    emit({ type: 'compact', before, after, auto });
    return true;
  }

  /** One model call, timed: time to first token, and output speed over the time spent generating. */
  /**
   * A model call that rides out a dropped connection, an overloaded or rate-limited
   * service: tried again after 2, 5, 10 and 20 s (once the browser is back online),
   * as long as nothing of the reply was shown yet.
   */
  async #turnRetrying(provider: Provider, tools: ToolDef[], signal: AbortSignal, emit: (e: AgentEvent) => void) {
    for (let attempt = 0; ; attempt++) {
      let shown = false;
      try {
        return await this.#turn(provider, tools, signal, (e) => ((shown ||= e.type !== 'status'), emit(e)));
      } catch (err) {
        const network = err instanceof TypeError && /fetch|network|load|connection/i.test(err.message);
        if (signal.aborted || shown || attempt >= RETRY_WAITS.length || !(network || (err instanceof ProviderError && err.retryable))) throw err;
        const why = network ? 'The connection was lost.' : (err as Error).message.replace(/\s*Wait a moment and try again\.?$/, '');
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          emit({ type: 'status', text: 'Offline: waiting for the connection to come back…' });
          await new Promise<void>((resolve) => {
            const done = () => (removeEventListener('online', done), signal.removeEventListener('abort', done), resolve());
            addEventListener('online', done);
            signal.addEventListener('abort', done);
          });
        } else {
          for (let left = RETRY_WAITS[attempt]!; left > 0 && !signal.aborted; left--) {
            emit({ type: 'status', text: `${why} Trying again in ${left} s (${attempt + 1} of ${RETRY_WAITS.length})…` });
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        signal.throwIfAborted();
        emit({ type: 'status', text: 'Trying again…' });
      }
    }
  }

  async #turn(provider: Provider, tools: ToolDef[], signal: AbortSignal, emit: (e: AgentEvent) => void) {
    // A status message (e.g. "Loading model…") means the model has not started yet: time from the last one.
    let t0 = performance.now();
    let first = 0;
    const result = await provider.turn({
      system: this.#system!,
      messages: await withImageData(this.os, provider.contextBudget ? fitContext(this.os, this.messages, provider.contextBudget) : this.messages, this.#images),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      signal,
      onText: (delta) => ((first ||= performance.now()), emit({ type: 'text', delta })),
      onThinking: (delta) => ((first ||= performance.now()), emit({ type: 'thinking', delta })),
      onStatus: (text) => {
        if (!first) t0 = performance.now();
        emit({ type: 'status', text });
      },
    });
    const end = performance.now();
    const generating = Math.max(1, end - (first || t0));
    // Too short a burst to measure (a cached or very short answer) gives no speed rather than a silly one.
    const stats: TurnStats = result.speed
      ? { ms: end - t0, ttft: result.speed.ttft, tps: result.speed.tps }
      : // Without streamed text (a reply that is only a tool call) there is no first token to time from.
        { ms: end - t0, ttft: (first || end) - t0, tps: first && result.usage.output > 1 && generating >= 150 ? result.usage.output / (generating / 1000) : 0 };
    return { ...result, stats };
  }

  async #runTools(calls: ToolUse[], tools: ToolDef[], signal: AbortSignal, emit: (e: AgentEvent) => void, plan = false): Promise<ToolResult[]> {
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
      seen: this.#seen,
      session: this.id,
      created: (p) => this.checkpoints.created(p),
      project: this.project,
      workspace: this.folder,
      setTodos: (items) => {
        this.todos = items;
        emit({ type: 'todos', items });
      },
      spawnAgent: (task, agent) => this.#spawn(id, task, agent, signal, (chunk) => emit({ type: 'tool_progress', id, chunk })),
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
        else if (plan && !readsOnly(call)) out = fail('Plan mode only looks: http_fetch may only GET, without save_to. Put the change in your plan instead.');
        else {
          const ctx = tc(call.id);
          summary = def.describe(call.input);
          emit({ type: 'tool_start', id: call.id, name: call.name, summary, input: call.input });
          announced = true;
          try {
            const cap = def.cap(call.input, ctx);
            // The user's rules come first: deny blocks, ask always prompts, allow skips the prompt.
            const rule = decide(loadRules(this.os), call.name, call.input, ctx.path);
            let allowed = rule?.action !== 'deny';
            // Accept-edits mode: the agent's file changes go through, except in the user's real folders (/mnt).
            const paths = changedPaths(call, ctx.path, this.project.id, this.project.folder);
            const editAccepted = !rule && cap === 'fs.write' && this.os.perms.mode === 'edits' && paths.length > 0 && paths.every((p) => !isInside('/mnt', p));
            if (rule?.action === 'ask' || (!rule && cap && !editAccepted)) {
              this.os.procs.update(this.proc.pid, { state: 'blocked' });
              const req = { cap: cap ?? 'system', actor: 'The agent', title: call.name, detail: summary } as const;
              allowed = rule ? (await (this.host.prompter ?? ((r) => this.os.perms.prompt(r)))(req)) !== 'deny' : await this.os.perms.request(req, this.host.prompter);
              this.os.procs.update(this.proc.pid, { state: 'running' });
            }
            signal.throwIfAborted();
            if (!allowed)
              out = fail(rule?.action === 'deny' ? `Blocked by the user's permission rule "${describeRule(rule.rule)}". Do not look for another way to do this; if it is needed, ask the user.` : 'The user denied permission for this action.');
            else {
              const hookPayload: HookPayload = { tool: call.name, input: call.input, ...(paths[0] ? { file: paths[0] } : typeof call.input.path === 'string' ? { file: ctx.path(call.input.path) } : {}) };
              const pre = await this.#hooks('PreToolUse', hookPayload, signal, emit);
              if (pre.blocked !== undefined) throw new Error(`Blocked by a hook: ${pre.blocked}`);
              // Keep what the files were, for undo, and show what changed.
              const before = paths.length ? await this.checkpoints.capture(paths) : null;
              const r = await def.run(call.input, ctx);
              out = typeof r === 'string' ? { type: 'tool_result', tool_use_id: call.id, content: r } : { type: 'tool_result', tool_use_id: call.id, content: r.text, images: r.images };
              const post = await this.#hooks('PostToolUse', { ...hookPayload, result: out.content }, signal, emit);
              const notes = [...post.context, ...(post.blocked !== undefined ? [post.blocked] : [])];
              if (notes.length) out = { ...out, content: `${out.content}\n\n[hook output]\n${notes.join('\n\n')}` };
              if (before && call.name !== 'move_path' && !call.name.endsWith('_artifact') && paths.length === 1) {
                const p = paths[0]!;
                if (before.has(p)) {
                  const after = await this.os.fs.readText(p).catch(() => null);
                  const diff = capDiff(diffFiles(p, before.get(p) ?? null, after));
                  this.diffs[call.id] = diff;
                  emit({ type: 'file_change', id: call.id, diff });
                }
              }
            }
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

    // Calls that only read run concurrently; anything that changes something runs in order.
    const parallel = calls.length > 1 && calls.every((c) => READ_ONLY.has(c.name) && c.invalid === undefined && tools.some((t) => t.name === c.name));
    if (parallel) return Promise.all(calls.map(one));
    const results: ToolResult[] = [];
    for (let i = 0; i < calls.length; ) {
      // Sub-agents asked for together run together (a few at a time). Their edits cannot clash
      // silently: an edit of a file another one changed is refused until it is read again.
      let j = i;
      while (j < calls.length && calls[j]!.name === 'spawn_agent') j++;
      if (j - i > 1) {
        results.push(...(await pooled(calls.slice(i, j), MAX_SUBAGENTS, one)));
        i = j;
      } else results.push(await one(calls[i++]!));
    }
    return results;
  }

  async #spawn(callId: string, task: string, agentName: string | undefined, signal: AbortSignal, progress: (chunk: string) => void): Promise<string> {
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
      // Its model: the custom agent's own, else the one set for sub-agents, else this agent's.
      { ppid: this.proc.pid, depth: this.#depth + 1, persona, project: this.project, folder: this.folder, model: persona?.model || loadConfig(this.os).subagentModel || this.#model || undefined },
    );
    const abort = () => child.stop();
    signal.addEventListener('abort', abort);
    try {
      await child.send(task);
      signal.throwIfAborted();
      return child.lastText() || '(the sub-agent produced no report)';
    } finally {
      this.subagents[callId] = child.transcript.slice(-200);
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
