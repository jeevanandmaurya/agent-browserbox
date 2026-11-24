import type { AgentEvent, AgentHandle, AgentsApi, BuiltinPromptInput } from '@jeevanand/agent-browserbox/ui';
import { BuiltinTooLarge, runBuiltinPrompt } from '@jeevanand/agent-browserbox/ui';
import type { RemoteKernel } from '@jeevanand/agent-browserbox-runtime/client';
import type { PermRequest, Prompter } from '@jeevanand/agent-browserbox-runtime/client';
import { Peer } from '@jeevanand/agent-browserbox-runtime/client';
import { notifyAway } from './attention';

type Ask = { askId: number; kind: 'perm' | 'user' | 'ui'; sid?: string; payload: unknown };

interface Local {
  events: Set<(e: AgentEvent) => void>;
  asker?: (q: string, o?: string[]) => Promise<string>;
  prompter?: Prompter;
}

/**
 * A window's handle on the app's agent worker: agent sessions (`agents.*`),
 * their events, and the questions they ask this window (permissions, ask_user,
 * clipboard). The kernel itself knows nothing about agents.
 */
export class AgentClient implements AgentsApi {
  #peer: Promise<Peer>;
  #sessions = new Map<string, Local>();
  #asking = new Map<number, AbortController>();

  constructor(
    port: Promise<MessagePort>,
    private os: RemoteKernel,
    lock?: string,
  ) {
    this.#peer = port.then((p) => {
      const peer = new Peer(p);
      peer.on<{ sid: string; event: AgentEvent }>('agent', ({ sid, event }) => {
        for (const fn of [...(this.#sessions.get(sid)?.events ?? [])]) fn(event);
      });
      peer.on<Ask>('ask', (ask) => void this.#answer(peer, ask));
      peer.on<number>('ask:done', (askId) => {
        this.#asking.get(askId)?.abort();
        this.#asking.delete(askId);
      });
      if (lock) peer.emit('alive', lock);
      return peer;
    });
  }

  #call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.#peer.then((p) => p.call<T>(method, ...args));
  }

  /** The agent worker needs something only a window can give: a decision, an answer, the clipboard. */
  async #answer(peer: Peer, ask: Ask): Promise<void> {
    const ctl = new AbortController();
    this.#asking.set(ask.askId, ctl);
    let value: unknown;
    // Away from this window: say that something waits (the card shows when you come back).
    const away = this.#awayNotice(ask);
    ctl.signal.addEventListener('abort', away);
    try {
      if (ask.kind === 'perm') {
        const custom = ask.sid ? this.#sessions.get(ask.sid)?.prompter : undefined;
        value = await (custom ? custom(ask.payload as PermRequest, ctl.signal) : this.os.perms.prompt(ask.payload as PermRequest, ctl.signal));
      } else if (ask.kind === 'user') {
        const asker = ask.sid ? this.#sessions.get(ask.sid)?.asker : undefined;
        if (!asker) return; // another window owns this conversation
        const { question, options } = ask.payload as { question: string; options?: string[] };
        value = await asker(question, options);
      } else {
        const { method, args } = ask.payload as { method: string; args: unknown[] };
        if (method === 'clipboard.write') value = await navigator.clipboard.writeText(String(args[0]));
        else if (method === 'clipboard.read') value = await navigator.clipboard.readText();
        else if (method === 'speak') speechSynthesis.speak(new SpeechSynthesisUtterance(String(args[0])));
        else if (method === 'lm.prompt') value = await runBuiltinPrompt(args[0] as BuiltinPromptInput, { signal: ctl.signal }).then((r) => r, (err: Error) => ({ error: err.message, tooLarge: err instanceof BuiltinTooLarge, window: (err as BuiltinTooLarge).window }));
      }
    } catch (err) {
      if (ctl.signal.aborted) return;
      value = ask.kind === 'perm' ? 'deny' : ask.kind === 'ui' ? `failed: ${(err as Error).message}` : null;
    }
    away();
    if (ctl.signal.aborted) return;
    this.#asking.delete(ask.askId);
    void peer.call('answer', ask.askId, value);
  }

  /** A notification for an approval or a question this window answers, when it is hidden. */
  #awayNotice(ask: Ask): () => void {
    const tag = `bbx-ask-${ask.askId}`;
    if (ask.kind === 'perm') {
      const req = ask.payload as PermRequest;
      return notifyAway({ title: `${req.actor || 'The agent'} needs your approval`, body: `${req.title}: ${req.detail}`, tag, sid: ask.sid, sticky: true });
    }
    if (ask.kind === 'user' && ask.sid && this.#sessions.get(ask.sid)?.asker) {
      const { question } = ask.payload as { question: string };
      return notifyAway({ title: 'The agent has a question', body: question, tag, sid: ask.sid, sticky: true });
    }
    return () => undefined;
  }

  create: AgentsApi['create'] = async (opts) => this.#handle(await this.#call<{ sid: string; pid: number }>('agent.create', opts));
  attach: AgentsApi['attach'] = async (sid) => this.#handle(await this.#call<{ sid: string; pid: number }>('agent.attach', sid));
  live: AgentsApi['live'] = () => this.#call('agent.live');
  probeModels: AgentsApi['probeModels'] = (baseUrl, kind) => this.#call('agent.probeModels', baseUrl, kind);
  probeMcp: AgentsApi['probeMcp'] = (name) => this.#call('agent.probeMcp', name);

  #handle({ sid, pid }: { sid: string; pid: number }): AgentHandle {
    const local: Local = { events: new Set() };
    this.#sessions.set(sid, local);
    const forget = () => {
      if (this.#sessions.get(sid) === local) this.#sessions.delete(sid);
    };
    return {
      sid,
      pid,
      send: (text, opts) => this.#call('agent.send', sid, text, opts),
      rewind: (index, files) => this.#call('agent.rewind', sid, index, files),
      changes: () => this.#call('agent.changes', sid),
      stop: () => void this.#call('agent.stop', sid),
      snapshot: () => this.#call('agent.snapshot', sid),
      context: () => this.#call('agent.context', sid),
      compact: () => this.#call('agent.compact', sid),
      onEvent: (fn) => {
        local.events.add(fn);
        return () => local.events.delete(fn);
      },
      onAsk: (fn) => {
        local.asker = fn;
      },
      get prompter() {
        return local.prompter;
      },
      set prompter(p) {
        local.prompter = p;
      },
      detach: () => {
        forget();
        void this.#call('agent.detach', sid);
      },
      dispose: () => {
        forget();
        void this.#call('agent.dispose', sid);
      },
    };
  }
}
