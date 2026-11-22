import type { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import { validate } from './schema.js';
import { BOX_TOOLS, clip, normalize, type TodoItem, type ToolContext, type ToolDef } from './tools.js';
import { ProviderError, type Block, type Msg, type Provider, type ToolSpec, type Usage } from './types.js';

/** A tool call the agent is about to run, as given to `approve`. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** One line describing the call, e.g. "Run: npm install". */
  summary: string;
}

export interface AgentOptions {
  /** The box the agent works in. */
  box: BrowserBox;
  /** The model: `anthropic({ apiKey })`, `openai({ baseUrl, model })`, or your own Provider. */
  model: Provider;
  /** Extra instructions, appended to the system prompt. */
  instructions?: string;
  /** The working folder for relative paths and commands. Default: the box's home. */
  cwd?: string;
  /** Model calls per send() before the agent stops. Default: 50. */
  maxSteps?: number;
  /**
   * Called before every tool call. Return false to decline it (the model is
   * told). Default: allow everything; the box is the sandbox.
   */
  approve?: (call: ToolCall) => boolean | Promise<boolean>;
  /** Extra tools, added to the built-in ones (a name that already exists replaces it). */
  tools?: ToolDef[];
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'status'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean }
  | { type: 'todos'; items: TodoItem[] }
  | { type: 'usage'; usage: Usage; model: string }
  | { type: 'error'; message: string; retryable: boolean }
  /** Always last. `text` is the agent's final answer for this message. */
  | { type: 'done'; reason: 'end' | 'max_steps' | 'max_tokens' | 'refusal' | 'stopped' | 'error'; text: string };

/** A conversation, as saved by `toJSON()` and restored by `Agent.restore()`. */
export interface SavedSession {
  version: 1;
  messages: Msg[];
  todos: TodoItem[];
  usage: Usage;
}

/** Turns callbacks into an async iterable. */
class Channel<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  push(item: T): void {
    this.#items.push(item);
    this.#wake?.();
  }
  close(): void {
    this.#closed = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.#items.length) yield this.#items.shift()!;
      if (this.#closed) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = null;
    }
  }
}

const lastText = (msgs: Msg[]) => {
  const m = [...msgs].reverse().find((x) => x.role === 'assistant');
  return m ? m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') : '';
};

/**
 * An AI agent that works in a BrowserBox: it reads and writes files, searches,
 * runs commands and JavaScript, all inside the box.
 *
 *   const agent = new Agent({ box, model: anthropic({ apiKey }) });
 *   for await (const e of agent.send('Make a todo app in ./todo')) …
 */
export class Agent {
  /** The whole conversation, in a provider-neutral form. */
  messages: Msg[] = [];
  todos: TodoItem[] = [];
  /** Tokens used so far, all calls together. */
  readonly usage: Usage = { input: 0, output: 0, cacheRead: 0 };
  readonly cwd: string;

  #opts: AgentOptions;
  #tools: Map<string, ToolDef>;
  #ctl: AbortController | null = null;

  constructor(opts: AgentOptions) {
    if (!opts.box) throw new Error('Agent: a box is required (BrowserBox.boot())');
    if (!opts.model) throw new Error('Agent: a model is required (anthropic(), openai(), or your own Provider)');
    this.#opts = opts;
    this.cwd = normalize(opts.cwd ?? opts.box.home);
    this.#tools = new Map([...BOX_TOOLS, ...(opts.tools ?? [])].map((t) => [t.name, t]));
  }

  /** Continues a saved conversation. */
  static restore(saved: SavedSession, opts: AgentOptions): Agent {
    if (saved?.version !== 1 || !Array.isArray(saved.messages)) throw new Error('Agent.restore: not a saved session');
    const agent = new Agent(opts);
    agent.messages = saved.messages;
    agent.todos = saved.todos ?? [];
    Object.assign(agent.usage, saved.usage);
    return agent;
  }

  toJSON(): SavedSession {
    return { version: 1, messages: this.messages, todos: this.todos, usage: { ...this.usage } };
  }

  /** True while a send() is running. */
  get busy(): boolean {
    return this.#ctl !== null;
  }

  /** Stops the current send() as soon as possible. */
  stop(): void {
    this.#ctl?.abort();
  }

  /** Sends a message and streams what the agent does until it is done. */
  send(text: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<AgentEvent> {
    if (this.#ctl) throw new Error('Agent is already working: wait for it to finish, or call stop()');
    const ctl = (this.#ctl = new AbortController());
    opts.signal?.addEventListener('abort', () => ctl.abort());
    const events = new Channel<AgentEvent>();
    void this.#loop(text, ctl.signal, (e) => events.push(e)).finally(() => {
      this.#ctl = null;
      events.close();
    });
    return events;
  }

  /** Sends a message and resolves with the final answer. Throws if the model fails. */
  async run(text: string, opts: { signal?: AbortSignal; onEvent?: (e: AgentEvent) => void } = {}): Promise<string> {
    let error: string | null = null;
    let final = '';
    for await (const e of this.send(text, opts)) {
      opts.onEvent?.(e);
      if (e.type === 'error') error = e.message;
      if (e.type === 'done') final = e.text;
    }
    if (error) throw new ProviderError(error);
    return final;
  }

  #system(): string {
    const { box } = this.#opts;
    return [
      'You are an agent working inside BrowserBox: a sandboxed computer that runs in a web browser, with its own filesystem, shell and code sandboxes. Nothing you do can affect the user\'s real machine.',
      '',
      '# Environment',
      `- Working folder: ${this.cwd}. Relative paths resolve against it. Home: ${box.home}. /tmp is temporary.`,
      `- Storage: ${box.storage === 'opfs' ? 'persistent (files survive reloads)' : 'in memory (files disappear when the box closes)'}.`,
      "- The shell is bbsh, not bash: Unix-style commands (ls, cat, grep, find, sort, head, tail, wc, mkdir, cp, mv, rm, curl, …), pipes, && and redirects. Run `help` for the full list.",
      '- JavaScript runs in a sandboxed worker (run_js, or `js file.js` in the shell). WebAssembly (WASI) runs with `wasm file.wasm`.',
      '- More software is installed with `pkg install <name>`: python, git, sqlite, zip, esbuild. `npm install` records dependencies; packages load from esm.sh when a project is bundled.',
      '- There is no Node.js, no native compilers and no system package manager. Network access may need the user\'s permission and can be refused.',
      '',
      '# How to work',
      '- Prefer the file tools (read_file, write_file, edit_file, list_dir, glob, grep) over shell commands for files.',
      '- Read a file before editing it. Check your work by running it where you can.',
      '- For multi-step tasks, keep a todo list with todo_write.',
      '- When done, reply with a short summary of what you did and anything the user should know.',
      ...(this.#opts.instructions ? ['', '# Instructions', this.#opts.instructions] : []),
    ].join('\n');
  }

  async #loop(text: string, signal: AbortSignal, emit: (e: AgentEvent) => void): Promise<void> {
    const { model } = this.#opts;
    const maxSteps = this.#opts.maxSteps ?? 50;
    const system = this.#system();
    const specs: ToolSpec[] = [...this.#tools.values()].map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    const done = (reason: Extract<AgentEvent, { type: 'done' }>['reason']) => emit({ type: 'done', reason, text: lastText(this.messages) });
    this.messages.push({ role: 'user', content: [{ type: 'text', text }] });

    for (let step = 0; ; step++) {
      if (signal.aborted) return done('stopped');
      if (step >= maxSteps) return done('max_steps');
      let res;
      try {
        res = await model.turn({
          system,
          messages: this.messages,
          tools: specs,
          signal,
          onText: (delta) => emit({ type: 'text', delta }),
          onThinking: (delta) => emit({ type: 'thinking', delta }),
          onStatus: (t) => emit({ type: 'status', text: t }),
        });
      } catch (err) {
        if (signal.aborted) return done('stopped');
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err), retryable: err instanceof ProviderError && err.retryable });
        return done('error');
      }
      this.usage.input += res.usage.input;
      this.usage.output += res.usage.output;
      this.usage.cacheRead += res.usage.cacheRead;
      emit({ type: 'usage', usage: res.usage, model: res.model });
      this.messages.push({ role: 'assistant', content: res.content, ...(res.raw ? { raw: res.raw } : {}) });

      if (res.stop === 'pause') continue; // a server-side tool wants the turn continued
      if (res.stop === 'refusal') return done('refusal');
      const calls = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!calls.length) return done(res.stop === 'max_tokens' ? 'max_tokens' : 'end');

      // Every call gets a result, in one message, even when stopped part-way:
      // the conversation must stay valid to continue.
      const results: Block[] = [];
      for (const call of calls) {
        const r = signal.aborted ? { content: 'Not run: the user stopped the agent.', isError: true } : await this.#runTool(call, signal, emit);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
        emit({ type: 'tool_result', id: call.id, name: call.name, content: r.content, isError: r.isError });
      }
      this.messages.push({ role: 'user', content: results });
    }
  }

  async #runTool(call: Extract<Block, { type: 'tool_use' }>, signal: AbortSignal, emit: (e: AgentEvent) => void): Promise<{ content: string; isError: boolean }> {
    const def = this.#tools.get(call.name);
    let summary = call.name;
    try {
      if (def) summary = def.describe(call.input as never);
    } catch {
      /* input too broken to describe */
    }
    emit({ type: 'tool_call', call: { id: call.id, name: call.name, input: call.input, summary } });
    if (!def) return { content: `Unknown tool "${call.name}". Available: ${[...this.#tools.keys()].join(', ')}.`, isError: true };
    // Tool inputs are untrusted model output (streamed eagerly, unchecked by the API).
    if (call.invalid !== undefined) return { content: 'The tool arguments were not valid JSON. Call the tool again with a JSON object.', isError: true };
    const problems = validate(def.input_schema, call.input);
    if (problems.length) return { content: `Invalid input: ${problems.join('; ')}.`, isError: true };
    if (this.#opts.approve && !(await this.#opts.approve({ id: call.id, name: call.name, input: call.input, summary }))) {
      return { content: 'The user declined this tool call. Do not retry it; continue another way or ask the user.', isError: true };
    }
    const ctx: ToolContext = {
      box: this.#opts.box,
      cwd: this.cwd,
      signal,
      path: (p) => normalize(p.startsWith('/') ? p : `${this.cwd}/${p}`),
      setTodos: (items) => {
        this.todos = items;
        emit({ type: 'todos', items });
      },
    };
    try {
      return { content: clip(await def.run(call.input, ctx)), isError: false };
    } catch (err) {
      return { content: clip(err instanceof Error ? err.message : String(err)), isError: true };
    }
  }
}
