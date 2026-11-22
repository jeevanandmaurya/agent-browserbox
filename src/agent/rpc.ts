import type { KernelCore } from '@/kernel/kernel';
import type { PermDecision, PermRequest } from '@/kernel/perms';
import type { ServerService } from '@/kernel-worker/server';
import type { AgentHandle } from './api';

/**
 * The agent service's RPC methods (`agent.*`), plugged into the kernel server
 * with `server.use(agentRpc(os))`. Each window attaches to sessions that live
 * in the kernel; leaving detaches it, and the sessions keep running.
 */
export function agentRpc(os: KernelCore): ServerService {
  return {
    connect(client) {
      const { peer } = client;
      const attached = new Map<string, AgentHandle>();
      const agent = (sid: string) => {
        const h = attached.get(sid);
        if (!h) throw new Error(`not attached to agent session ${sid}`);
        return h;
      };
      const adopt = (h: AgentHandle) => {
        attached.get(h.sid)?.detach();
        attached.set(h.sid, h);
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
        h.onAsk((question, options) => client.ask<string>({ kind: 'user', sid: h.sid, payload: { question, options } }, undefined, true));
        h.prompter = (req: PermRequest, signal) => client.ask<PermDecision>({ kind: 'perm', sid: h.sid, payload: req }, signal).catch(() => 'deny' as const);
        return { sid: h.sid, pid: h.pid };
      };

      return {
        handlers: {
          'agent.create': async (opts?: { resume?: string; ppid?: number; private?: boolean }) => adopt(await os.agents.create(opts)),
          'agent.attach': async (sid: string) => adopt(await os.agents.attach(sid)),
          'agent.live': () => os.agents.live(),
          'agent.probeModels': (baseUrl: string, kind?: 'local' | 'openai') => os.agents.probeModels(baseUrl, kind),
          'agent.send': (sid: string, text: string, opts?: { plan?: boolean }) => agent(sid).send(text, opts),
          'agent.rewind': (sid: string, index: number, files: boolean) => agent(sid).rewind(index, files),
          'agent.changes': (sid: string) => agent(sid).changes(),
          'agent.stop': (sid: string) => agent(sid).stop(),
          'agent.snapshot': (sid: string) => agent(sid).snapshot(),
          'agent.context': (sid: string) => agent(sid).context(),
          'agent.compact': (sid: string) => agent(sid).compact(),
          'agent.probeMcp': (name: string) => os.agents.probeMcp(name),
          'agent.detach': (sid: string) => {
            attached.get(sid)?.detach();
            attached.delete(sid);
          },
          'agent.dispose': (sid: string) => {
            attached.get(sid)?.dispose();
            attached.delete(sid);
          },
        },
        drop() {
          for (const h of attached.values()) h.detach(); // sessions keep running
        },
      };
    },
  };
}
