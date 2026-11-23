import type { AgentHandle, AgentInfo, AgentsApi, AgentSnapshot } from './api.js';
import type { KernelCore } from './host/os.js';
import type { Prompter } from './host/perms.js';
import { Agent, type AgentEvent } from './agent.js';
import { apiKeyFor, loadConfig, probeModels, SECRET } from './config.js';
import { loadSession, saveSession, titleFrom } from './session.js';

interface Session {
  agent: Agent;
  listeners: Set<(e: AgentEvent) => void>;
  asker: ((q: string, options?: string[]) => Promise<string>) | null;
  /** Questions asked while no window was attached. */
  waiting: Array<{ q: string; options?: string[]; resolve: (a: string) => void }>;
  prompter?: Prompter;
  created: number;
  /** Never written to disk; discarded when its window leaves it. */
  private: boolean;
}

/**
 * Owns every agent session. Sessions live in the kernel, not in a window:
 * closing the agent window detaches from a session without stopping it, and
 * any window can attach to it again later.
 */
export class AgentManager implements AgentsApi {
  #sessions = new Map<string, Session>();

  constructor(private os: KernelCore) {
    os.procs.onExit((pid) => {
      for (const [sid, s] of this.#sessions) if (s.agent.proc.pid === pid) this.#sessions.delete(sid);
    });
  }

  async create(opts: { resume?: string; ppid?: number; private?: boolean } = {}): Promise<AgentHandle> {
    const saved = opts.resume ? await loadSession(this.os, opts.resume) : null;
    const live = saved && this.#sessions.get(saved.id);
    if (live) return this.#handle(saved.id, live);

    const session: Session = { listeners: new Set(), asker: null, waiting: [], created: Date.now(), private: !opts.resume && !!opts.private } as unknown as Session;
    const agent = new Agent(
      this.os,
      {
        onEvent: (e) => {
          for (const fn of [...session.listeners]) fn(e);
          // Saved after every model call too, so a running chat is listed and survives a reload.
          if (e.type === 'done' || e.type === 'usage') void this.#save(session);
        },
        ask: (q, options) => (session.asker ? session.asker(q, options) : new Promise((resolve) => session.waiting.push({ q, options, resolve }))),
        get prompter() {
          return session.prompter;
        },
      },
      { ppid: opts.ppid, id: saved?.id },
    );
    session.agent = agent;
    if (saved) {
      agent.messages = saved.messages;
      agent.transcript = saved.transcript ?? saved.messages;
      agent.todos = saved.todos ?? [];
      agent.checkpoints.list = saved.checkpoints ?? [];
      agent.diffs = saved.diffs ?? {};
    }
    this.#sessions.set(agent.id, session);
    return this.#handle(agent.id, session);
  }

  async attach(sid: string): Promise<AgentHandle> {
    const s = this.#sessions.get(sid);
    if (!s) throw new Error(`no live agent session: ${sid}`);
    return this.#handle(sid, s);
  }

  async live(): Promise<AgentInfo[]> {
    return [...this.#sessions.entries()]
      .filter(([, s]) => !s.private)
      .sort((a, b) => b[1].created - a[1].created)
      .map(([sid, s]) => ({ sid, pid: s.agent.proc.pid, busy: s.agent.busy, title: titleFrom(s.agent.transcript) }));
  }

  probeMcp(name: string): Promise<Array<{ name: string; description: string }>> {
    return this.os.mcp.probe(name);
  }

  async probeModels(baseUrl: string, kind: 'local' | 'api' = 'local'): Promise<string[]> {
    const key = kind === 'local' ? await this.os.secrets.get(SECRET.local) : await apiKeyFor(this.os.secrets, baseUrl);
    return probeModels(baseUrl, key, undefined, { kind, relay: kind === 'api' ? loadConfig(this.os).corsRelay : '' });
  }

  async #save(s: Session): Promise<void> {
    if (s.private || !s.agent.transcript.length) return;
    await saveSession(this.os, { id: s.agent.id, title: titleFrom(s.agent.transcript), updated: Date.now(), messages: s.agent.messages, transcript: s.agent.transcript, todos: s.agent.todos, checkpoints: s.agent.checkpoints.list, diffs: s.agent.diffs }).catch((err: Error) =>
      this.os.notify({ title: 'Could not save the agent session', body: err.message, level: 'warn' }),
    );
  }

  #handle(sid: string, s: Session): AgentHandle {
    const mine = new Set<(e: AgentEvent) => void>();
    let myAsker: Session['asker'] = null;
    const sessions = this.#sessions;
    const release = () => {
      for (const fn of mine) s.listeners.delete(fn);
      mine.clear();
      if (s.asker === myAsker) s.asker = null;
    };
    return {
      sid,
      pid: s.agent.proc.pid,
      send: (text, opts) => s.agent.send(text, opts),
      rewind: async (index, files) => {
        const r = await s.agent.rewind(index, files);
        await this.#save(s);
        return r;
      },
      changes: async () => s.agent.checkpoints.list.map((c) => ({ turn: c.turn, at: c.at, files: c.files.map((f) => ({ path: f.path, before: f.binary ? null : f.before, existed: f.before !== null || !!f.skipped, binary: !!f.binary, skipped: !!f.skipped })) })),
      stop: () => s.agent.stop(),
      context: async () => s.agent.context(),
      compact: () => s.agent.compact(),
      async snapshot(): Promise<AgentSnapshot> {
        return { sid, private: s.private, pid: s.agent.proc.pid, busy: s.agent.busy, title: titleFrom(s.agent.transcript), messages: s.agent.transcript, todos: s.agent.todos, total: { ...s.agent.total }, context: s.agent.context(), diffs: s.agent.diffs };
      },
      onEvent(fn) {
        mine.add(fn);
        s.listeners.add(fn);
        return () => {
          mine.delete(fn);
          s.listeners.delete(fn);
        };
      },
      onAsk(fn) {
        myAsker = s.asker = fn;
        for (const w of s.waiting.splice(0)) void fn(w.q, w.options).then(w.resolve);
      },
      get prompter() {
        return s.prompter;
      },
      set prompter(p) {
        s.prompter = p;
      },
      detach() {
        // A private chat has nowhere to go back to: leaving it ends it.
        if (s.private) return this.dispose();
        release();
      },
      dispose() {
        release();
        sessions.delete(sid);
        s.agent.dispose();
      },
    };
  }
}
