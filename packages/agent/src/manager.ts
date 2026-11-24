import type { AgentHandle, AgentInfo, AgentsApi, AgentSnapshot } from './api.js';
import type { KernelCore } from './host/os.js';
import type { Prompter } from './host/perms.js';
import { Agent, type AgentEvent } from './agent.js';
import { apiKeyFor, loadConfig, migrateKeys, probeModels, SECRET } from './config.js';
import { attachmentsDir, loadSession, saveSession, titleFrom } from './session.js';
import { GENERAL_ID, getProject } from './projects.js';

/** Most events kept for a window that joins mid-turn; text deltas are merged. */
const LIVE_MAX = 400;

/**
 * Keeps the events since the transcript last grew (the step in progress), so a
 * window that opens the chat now sees what the others see: text being written,
 * tools running. Cleared when a message lands in the transcript or the turn ends.
 */
function keepLive(s: { agent: { transcript: unknown[] }; live: AgentEvent[]; liveAt: number }, e: AgentEvent): void {
  const at = s.agent.transcript.length;
  if (at !== s.liveAt) {
    s.live = [];
    s.liveAt = at;
  }
  if (e.type === 'done') return void (s.live = []);
  if (!['text', 'thinking', 'status', 'note', 'tool_start', 'tool_progress', 'tool_end', 'hook', 'error'].includes(e.type)) return;
  const last = s.live.at(-1);
  if ((e.type === 'text' || e.type === 'thinking') && last?.type === e.type) return void (s.live[s.live.length - 1] = { type: e.type, delta: last.delta + e.delta });
  if (e.type === 'tool_progress' && last?.type === 'tool_progress' && last.id === e.id) return void (s.live[s.live.length - 1] = { ...last, chunk: (last.chunk + e.chunk).slice(-8000) });
  if (s.live.length < LIVE_MAX) s.live.push(e);
}

interface Session {
  agent: Agent;
  listeners: Set<(e: AgentEvent) => void>;
  /** The current step's events not yet in the transcript, and the transcript length they follow. */
  live: AgentEvent[];
  liveAt: number;
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
    // Keys saved before 0.3 move to their per-service names, so Settings shows them where they belong.
    void migrateKeys(os).catch(() => undefined);
    os.procs.onExit((pid) => {
      for (const [sid, s] of this.#sessions) if (s.agent.proc.pid === pid) this.#sessions.delete(sid);
    });
  }

  async create(opts: { resume?: string; ppid?: number; private?: boolean; project?: string; isolated?: boolean } = {}): Promise<AgentHandle> {
    const saved = opts.resume ? await loadSession(this.os, opts.resume) : null;
    const live = saved && this.#sessions.get(saved.id);
    if (live) return this.#handle(saved.id, live);

    const session: Session = { listeners: new Set(), live: [], liveAt: 0, asker: null, waiting: [], created: Date.now(), private: !opts.resume && !!opts.private } as unknown as Session;
    const agent = new Agent(
      this.os,
      {
        onEvent: (e) => {
          keepLive(session, e);
          for (const fn of [...session.listeners]) fn(e);
          // Saved after every model call too, so a running chat is listed and survives a reload.
          if (e.type === 'done' || e.type === 'usage') void this.#save(session);
        },
        ask: (q, options) => (session.asker ? session.asker(q, options) : new Promise((resolve) => session.waiting.push({ q, options, resolve }))),
        get prompter() {
          return session.prompter;
        },
      },
      { ppid: opts.ppid, id: saved?.id, project: getProject(this.os, saved ? (saved.project ?? GENERAL_ID) : opts.project) },
    );
    session.agent = agent;
    if (saved) {
      agent.messages = saved.messages;
      agent.transcript = saved.transcript ?? saved.messages;
      agent.todos = saved.todos ?? [];
      agent.checkpoints.list = saved.checkpoints ?? [];
      agent.diffs = saved.diffs ?? {};
      agent.subagents = saved.subagents ?? {};
    }
    // Its own copy of the folder: mounted again after a reload.
    if (saved?.isolated || (!saved && opts.isolated)) {
      await agent.isolate(true).catch((err: Error) => this.os.notify({ title: 'This chat works in the project folder itself', body: `Its copy could not be set up: ${err.message}`, level: 'warn' }));
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
      .map(([sid, s]) => ({ sid, pid: s.agent.proc.pid, busy: s.agent.busy, waiting: s.agent.proc.state === 'blocked', title: titleFrom(s.agent.transcript), project: s.agent.project.id }));
  }

  probeMcp(name: string): Promise<Array<{ name: string; description: string }>> {
    return this.os.mcp.probe(name);
  }

  async probeModels(baseUrl: string, kind: 'local' | 'api' = 'local'): Promise<string[]> {
    const key = kind === 'local' ? await this.os.secrets.get(SECRET.local) : await apiKeyFor(this.os.secrets, baseUrl, loadConfig(this.os).legacyKeyHost);
    return probeModels(baseUrl, key, undefined, { kind, relay: kind === 'api' ? loadConfig(this.os).corsRelay : '' });
  }

  async #save(s: Session): Promise<void> {
    // A chat that was ended (deleted, closed) is not saved again by its last events.
    if (s.private || !s.agent.transcript.length || this.#sessions.get(s.agent.id) !== s) return;
    await saveSession(this.os, { id: s.agent.id, title: titleFrom(s.agent.transcript), updated: Date.now(), project: s.agent.project.id, messages: s.agent.messages, transcript: s.agent.transcript, todos: s.agent.todos, checkpoints: s.agent.checkpoints.list, diffs: s.agent.diffs, subagents: s.agent.subagents, isolated: s.agent.isolated || undefined }).catch((err: Error) =>
      this.os.notify({ title: 'Could not save the agent session', body: err.message, level: 'warn' }),
    );
  }

  #handle(sid: string, s: Session): AgentHandle {
    const mine = new Set<(e: AgentEvent) => void>();
    let myAsker: Session['asker'] = null;
    const sessions = this.#sessions;
    const os = this.os;
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
      isolation: async () => (s.agent.isolated ? { folder: s.agent.folder, lower: s.agent.project.folder, changes: await os.fs.overlayChanges(s.agent.folder) } : null),
      isolate: async (on) => {
        await s.agent.isolate(on);
        await this.#save(s);
      },
      applyWork: (paths) => {
        if (!s.agent.isolated) throw new Error('this chat is not isolated');
        return os.fs.overlayApply(s.agent.folder, paths);
      },
      discardWork: async (paths) => {
        if (!s.agent.isolated) throw new Error('this chat is not isolated');
        await os.fs.overlayDiscard(s.agent.folder, paths);
      },
      stop: () => s.agent.stop(),
      context: async () => s.agent.context(),
      compact: () => s.agent.compact(),
      async snapshot(): Promise<AgentSnapshot> {
        return { sid, private: s.private, pid: s.agent.proc.pid, busy: s.agent.busy, live: s.agent.busy && s.liveAt === s.agent.transcript.length ? s.live.slice() : [], title: titleFrom(s.agent.transcript), messages: s.agent.transcript, todos: s.agent.todos, total: { ...s.agent.total }, context: s.agent.context(), diffs: s.agent.diffs, subagents: s.agent.subagents, project: s.agent.project.id, isolated: s.agent.isolated ? { folder: s.agent.folder, lower: s.agent.project.folder } : undefined };
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
        // A private chat leaves nothing behind, its attachments included.
        if (s.private) void os.fs.rm(attachmentsDir(sid).replace(/\/files$/, ''), { recursive: true }).catch(() => undefined);
      },
    };
  }
}
