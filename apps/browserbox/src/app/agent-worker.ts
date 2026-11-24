import { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import { AGENT_COMMANDS, AgentManager, AgentOs, BrowserSecrets, Scheduler, pathIn, type AgentHandle, type PermDecision, type PermRequest, type ProcTable, type SettingsApi } from '@jeevanand/agent-browserbox';
import { RemoteKernel } from '@jeevanand/agent-browserbox-runtime/client';
import { Peer } from '@jeevanand/agent-browserbox-runtime/client';
import { APP_MANIFESTS } from '@/ui/app-manifest';

/**
 * The app's agent service. A SharedWorker every BrowserBox window connects to
 * (or a worker per window where SharedWorker is missing), running the agent
 * package (@jeevanand/agent-browserbox) on the box a window shares with it.
 * Conversations live here, not in a window: closing the agent window leaves
 * them running, and any window can attach to them again.
 *
 * It speaks the same `agent.*` protocol the kernel spoke before, so the
 * windows' agent UI is unchanged.
 */

type Ask = { askId: number; kind: 'perm' | 'user' | 'ui'; sid?: string; payload: unknown };
interface Client {
  id: number;
  peer: Peer;
  agents: Map<string, AgentHandle>;
}

const clients = new Map<number, Client>();
let nextClient = 1;
let nextAsk = 1;
const asks = new Map<number, { ask: Ask; resolve: (v: unknown) => void; targets: Set<number> }>();

/** Asks windows something and waits for the first answer (only `only` when given). */
function ask<T>(a: Omit<Ask, 'askId'>, signal?: AbortSignal, only?: Client): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const askId = nextAsk++;
    const full: Ask = { ...a, askId };
    const targets = only ? [only] : [...clients.values()];
    if (!targets.length) return reject(new Error('no window is open to answer'));
    const done = (v: unknown) => {
      if (!asks.delete(askId)) return;
      for (const c of targets) c.peer.emit('ask:done', askId);
      resolve(v as T);
    };
    asks.set(askId, { ask: full, resolve: done, targets: new Set(targets.map((c) => c.id)) });
    signal?.addEventListener('abort', () => {
      if (!asks.delete(askId)) return;
      for (const c of targets) c.peer.emit('ask:done', askId);
      reject(signal.reason);
    });
    for (const c of targets) c.peer.emit('ask', full);
  });
}

/** The profile this worker serves, from its name (see boot.ts). */
const PROFILE_ID = /^bbx-agent:([A-Za-z0-9_-]{1,64})$/.exec((self as unknown as { name?: string }).name ?? '')?.[1] ?? 'default';

// ---- the box, borrowed from a window ---------------------------------------------
let provider: Client | null = null;
let world: Promise<{ os: AgentOs; agents: AgentManager }> | null = null;

/** Asks a window for a connection to its box (box.share()) and attaches to it. */
async function borrowBox(): Promise<BrowserBox> {
  for (;;) {
    const from = [...clients.values()].find((c) => c !== provider) ?? [...clients.values()][0];
    if (!from) throw new Error('no window is open to lend the agent a box');
    provider = from;
    const port = await new Promise<MessagePort>((resolve, reject) => {
      const off = from.peer.on<MessagePort>('box', (p) => (off(), resolve(p)));
      from.peer.emit('box:need');
      setTimeout(() => (off(), reject(new Error('the window did not lend a box'))), 30_000);
    }).catch(() => null);
    if (!port) continue;
    return BrowserBox.attach(port, { permissions: (req) => ask<PermDecision>({ kind: 'perm', payload: req }).catch(() => 'deny' as const), timeoutMs: 60_000 });
  }
}

// ---- the kernel, reached through the borrowed box ----------------------------------
// Everything the worker reaches goes through the window that lent the box. When that
// window closes, the kernel drops this client (its processes, its commands), so the
// worker moves to another window's box and a new kernel client, and puts it all back.
let kernel: RemoteKernel | null = null;

/** A kernel client of our own, through a box: settings, the process table, commands. */
async function kernelFor(box: BrowserBox): Promise<RemoteKernel> {
  const k = new RemoteKernel(box.kernelPort(), 'sdk');
  await k.ready;
  return k;
}

/** The agent's settings (model, permissions, connectors), in the kernel, through the current client. */
const settings: SettingsApi = {
  get: (key, fallback) => kernel!.settings.get(key, fallback),
  set: (key, value) => kernel!.settings.set(key, value),
  delete: (key) => kernel!.settings.delete(key),
  keys: () => kernel!.settings.keys(),
};

/**
 * The agent's processes, registered in the kernel's process table so they show in the
 * Task Manager and can be killed from there. Ids stay stable when the client changes.
 */
type Spawn = Parameters<ProcTable['spawn']>[0];
const registered = new Map<number, { o: Spawn; kpid: number; proc: ReturnType<ProcTable['spawn']> }>();
let nextLocalPid = 1;
const procs: ProcTable = {
  spawn(o) {
    const kp = kernel!.procs.spawn(o as never);
    const pid = nextLocalPid++;
    const proc = { pid, ppid: o.ppid ?? 0, name: o.name, kind: o.kind, started: Date.now(), state: 'running' as const, detail: o.detail ?? '', cpuMs: 0, memBytes: 0, signal: kp.signal };
    registered.set(pid, { o, kpid: kp.pid, proc });
    return proc;
  },
  update(pid, patch) {
    const r = registered.get(pid);
    if (!r) return;
    Object.assign(r.proc, patch);
    kernel!.procs.update(r.kpid, patch);
  },
  account(pid, ms) {
    const r = registered.get(pid);
    if (r) kernel!.procs.account(r.kpid, ms);
  },
  exit(pid) {
    const r = registered.get(pid);
    if (!r) return;
    registered.delete(pid);
    kernel!.procs.exit(r.kpid);
  },
  kill(pid) {
    const r = registered.get(pid);
    if (!r) return false;
    registered.delete(pid);
    r.o.onKill?.();
    return kernel!.procs.kill(r.kpid);
  },
  list: () => [...registered.values()].map((r) => r.proc),
};

/** Moves the agent's registrations to a new kernel client. */
function reRegister(k: RemoteKernel): void {
  for (const r of registered.values()) {
    const kp = k.procs.spawn({ ...r.o, detail: r.proc.detail } as never);
    r.kpid = kp.pid;
    k.procs.update(kp.pid, { state: r.proc.state });
  }
}

/** The agent's world, made on first use: the box, the kernel's settings and process table, the keys. */
function ensureWorld(): Promise<{ os: AgentOs; agents: AgentManager }> {
  return (world ??= (async () => {
    const box = await borrowBox();
    kernel = await kernelFor(box);
    const os = await AgentOs.create(box, {
      settings,
      // This worker serves one profile (its name says which): that profile's keys.
      secrets: new BrowserSecrets(PROFILE_ID === 'default' ? 'bbx-secrets' : `bbx-secrets:profile:${PROFILE_ID}`),
      procs,
      prompter: (req: PermRequest, signal?: AbortSignal) => ask<PermDecision>({ kind: 'perm', payload: req }, signal).catch(() => 'deny' as const),
      ui: {
        notify: (n) => kernel!.notify(n),
        openApp: (id, args) => kernel!.openApp(id, args),
        apps: APP_MANIFESTS.map((a) => ({ id: a.id, name: a.name, hidden: a.hidden })),
        clipboardRead: () => ask<string>({ kind: 'ui', payload: { method: 'clipboard.read', args: [] } }),
        clipboardWrite: (text) => ask<void>({ kind: 'ui', payload: { method: 'clipboard.write', args: [text] } }),
        speak: (text) => void ask({ kind: 'ui', payload: { method: 'speak', args: [text] } }).catch(() => undefined),
        // The browser's built-in model runs in a page: one window, the one lending the box, so it runs once.
        builtinPrompt: async (input, signal) => {
          const r = await ask<{ text?: string; window?: number; error?: string; tooLarge?: boolean }>({ kind: 'ui', payload: { method: 'lm.prompt', args: [input] } }, signal, provider ?? undefined);
          if (r?.tooLarge) return { text: '', window: r.window, tooLarge: true };
          if (typeof r?.text !== 'string') throw new Error(r?.error ?? 'no window could run the built-in model');
          return { text: r.text, window: r.window };
        },
      },
    });
    await offerCommands(kernel, os);
    const agents = new AgentManager(os);
    startScheduler(os, agents);
    return { os, agents };
  })().catch((err) => {
    world = null;
    throw err;
  }));
}

/**
 * Scheduled tasks run here, in the profile's agent worker, while any window of
 * the profile is open. One worker per profile (a SharedWorker), and a Web Lock
 * per task where SharedWorker is missing, so a task never runs twice at once.
 */
let scheduler: Scheduler | null = null;
function startScheduler(os: AgentOs, agents: AgentManager): void {
  scheduler?.stop();
  scheduler = new Scheduler(os, agents, {
    notify: (n) => {
      kernel?.notify({ title: n.title, body: n.body, level: n.error ? 'warn' : 'ok' });
      // A system notification too, when the user allowed them (Settings → Permissions).
      try {
        if (globalThis.Notification?.permission === 'granted') new Notification(n.title, { body: n.body, tag: n.session });
      } catch {
        /* not available in this kind of worker */
      }
    },
    exclusive: (name, fn) => (navigator.locks ? navigator.locks.request(name, { ifAvailable: true }, (lock) => (lock ? fn() : undefined)) : fn()),
  });
  scheduler.start();
}

/**
 * The agent's terminal commands (setup, agent, gh, deploy), offered in every
 * shell of the box: the kernel forwards them here and streams their I/O.
 */
async function offerCommands(kernel: RemoteKernel, os: AgentOs): Promise<void> {
  const aborts = new Map<number, AbortController>();
  const peer = await kernel.handle({
    'cmd.run': async (runId: number, name: string, o: { args: string[]; stdin: string; cwd: string; tty: boolean }) => {
      const cmd = AGENT_COMMANDS.find((c) => c.name === name);
      const err = (t: string) => peer.emit('cmd:out', { runId, s: 'e', t });
      if (!cmd) return err(`${name}: not available\n`), 127;
      const ctl = new AbortController();
      aborts.set(runId, ctl);
      try {
        const code = await cmd.run({
          os,
          args: o.args,
          stdin: o.stdin,
          cwd: o.cwd,
          path: pathIn(o.cwd),
          signal: ctl.signal,
          out: (t) => peer.emit('cmd:out', { runId, s: 'o', t }),
          err,
          tty: o.tty ? { readLine: (prompt, opts) => kernel.call<string | null>('cmd.readLine', runId, prompt, !!opts?.secret) } : undefined,
        });
        return typeof code === 'number' ? code : 0;
      } catch (e) {
        if (!ctl.signal.aborted) err(`${name}: ${(e as Error).message}\n`);
        return ctl.signal.aborted ? 130 : 1;
      } finally {
        aborts.delete(runId);
      }
    },
  });
  peer.on<number>('cmd:abort', (runId) => aborts.get(runId)?.abort());
  await kernel.call('shell.contribute', AGENT_COMMANDS.map(({ name, summary, usage }) => ({ name, summary, usage })));
}

/** The window that lent the box went away: move to another window's box and kernel client. */
let rehoming: Promise<void> | null = null;
function rehome(): Promise<void> {
  return (rehoming ??= (async () => {
    if (!world) return;
    const { os } = await world;
    if (!clients.size) return; // the next window to connect lends one (see connect)
    const box = await borrowBox();
    const k = await kernelFor(box);
    kernel = k;
    reRegister(k);
    os.setBox(box);
    await offerCommands(k, os);
  })().finally(() => (rehoming = null)));
}

// ---- windows ------------------------------------------------------------------------
function connect(port: MessagePort): void {
  const peer = new Peer(port);
  const client: Client = { id: nextClient++, peer, agents: new Map() };
  const agent = (sid: string) => {
    const h = client.agents.get(sid);
    if (!h) throw new Error(`not attached to agent session ${sid}`);
    return h;
  };
  const adopt = (h: AgentHandle) => {
    client.agents.get(h.sid)?.detach();
    client.agents.set(h.sid, h);
    // Streaming deltas arrive token by token; coalesce them so a slow device
    // handles ~30 messages a second instead of hundreds.
    let held: { type: 'text' | 'thinking'; delta: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (held) peer.emit('agent', { sid: h.sid, event: held });
      held = null;
    };
    h.onEvent((event) => {
      if (event.type === 'text' || event.type === 'thinking') {
        if (held && held.type !== event.type) flush();
        if (held) held.delta += event.delta;
        else held = { type: event.type, delta: event.delta };
        timer ??= setTimeout(flush, 33);
        return;
      }
      flush();
      peer.emit('agent', { sid: h.sid, event });
    });
    h.onAsk((question, options) => ask<string>({ kind: 'user', sid: h.sid, payload: { question, options } }, undefined, client));
    h.prompter = (req: PermRequest, signal) => ask<PermDecision>({ kind: 'perm', sid: h.sid, payload: req }, signal).catch(() => 'deny' as const);
    return { sid: h.sid, pid: h.pid };
  };
  const agents = async () => (await ensureWorld()).agents;

  peer.handle({
    'agent.create': async (opts?: { resume?: string; ppid?: number; private?: boolean; project?: string }) => adopt(await (await agents()).create(opts)),
    'agent.attach': async (sid: string) => adopt(await (await agents()).attach(sid)),
    'agent.live': async () => (await agents()).live(),
    'agent.probeModels': async (baseUrl: string, kind?: 'local' | 'api') => (await agents()).probeModels(baseUrl, kind),
    'agent.probeMcp': async (name: string) => (await agents()).probeMcp(name),
    'agent.send': (sid: string, text: string, opts?: { plan?: boolean; images?: string[] }) => agent(sid).send(text, opts),
    'agent.rewind': (sid: string, index: number, files: boolean) => agent(sid).rewind(index, files),
    'agent.changes': (sid: string) => agent(sid).changes(),
    'agent.stop': (sid: string) => agent(sid).stop(),
    'agent.snapshot': (sid: string) => agent(sid).snapshot(),
    'agent.context': (sid: string) => agent(sid).context(),
    'agent.compact': (sid: string) => agent(sid).compact(),
    'agent.detach': (sid: string) => {
      client.agents.get(sid)?.detach();
      client.agents.delete(sid);
    },
    'agent.dispose': (sid: string) => {
      client.agents.get(sid)?.dispose();
      client.agents.delete(sid);
    },
    answer: (askId: number, value: unknown) => {
      const a = asks.get(askId);
      if (a?.targets.has(client.id)) a.resolve(value);
    },
  });
  // A window announces the Web Lock it holds; when we can take it, the window is gone.
  peer.on<string>('alive', (lock) => void navigator.locks?.request(lock, () => drop(client)));
  clients.set(client.id, client);
  // Get ready as soon as a window is here, so the agent's terminal commands are offered early;
  // after every window had closed, move to this one.
  void (world && !provider ? rehome() : ensureWorld()).catch(() => undefined);
}

function drop(client: Client): void {
  if (!clients.delete(client.id)) return;
  client.peer.close();
  for (const h of client.agents.values()) h.detach(); // conversations keep running
  for (const [askId, a] of asks) {
    a.targets.delete(client.id);
    if (!a.targets.size) {
      asks.delete(askId);
      a.resolve(a.ask.kind === 'perm' ? 'deny' : null);
    }
  }
  if (client === provider) {
    provider = null;
    void rehome().catch(() => undefined);
  }
}

type Handler = ((e: MessageEvent) => void) | null;
const scope = self as unknown as { onconnect: Handler; onmessage: Handler };
if ('SharedWorkerGlobalScope' in self) scope.onconnect = (e) => connect(e.ports[0]!);
else scope.onmessage = (e) => e.data?.type === 'connect' && connect(e.ports[0]!);
