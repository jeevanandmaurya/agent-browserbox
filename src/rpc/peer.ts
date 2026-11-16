/**
 * Minimal bidirectional RPC over a MessagePort: request/response calls plus
 * one-way events. This is the only thing that crosses between the kernel
 * worker and a window, so it is also the kernel's security boundary.
 */
type Wire =
  | { k: 'call'; id: number; m: string; a: unknown[] }
  | { k: 'ok'; id: number; v: unknown }
  | { k: 'err'; id: number; e: { name: string; message: string } }
  | { k: 'evt'; n: string; p: unknown };

export type Handlers = Record<string, (...args: never[]) => unknown>;

export class Peer {
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #handlers: Handlers = {};
  #listeners = new Map<string, Set<(p: never) => void>>();
  closed = false;

  constructor(private port: MessagePort) {
    port.onmessage = (e) => void this.#receive(e.data as Wire);
  }

  handle(handlers: Handlers): this {
    Object.assign(this.#handlers, handlers);
    return this;
  }

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    return new Promise<T>((resolve, reject) => {
      const id = this.#next++;
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ k: 'call', id, m: method, a: args } satisfies Wire);
    });
  }

  emit(name: string, payload?: unknown): void {
    if (!this.closed) this.port.postMessage({ k: 'evt', n: name, p: payload } satisfies Wire);
  }

  on<P = unknown>(name: string, fn: (payload: P) => void): () => void {
    let set = this.#listeners.get(name);
    if (!set) this.#listeners.set(name, (set = new Set()));
    set.add(fn as (p: never) => void);
    return () => set.delete(fn as (p: never) => void);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.close();
    for (const p of this.#pending.values()) p.reject(new Error('connection closed'));
    this.#pending.clear();
  }

  async #receive(msg: Wire): Promise<void> {
    if (msg.k === 'call') {
      const fn = Object.hasOwn(this.#handlers, msg.m) ? (this.#handlers[msg.m] as (...a: unknown[]) => unknown) : undefined;
      try {
        if (!fn) throw new Error(`unknown method: ${msg.m}`);
        const v = await fn(...msg.a);
        if (!this.closed) this.port.postMessage({ k: 'ok', id: msg.id, v } satisfies Wire);
      } catch (err) {
        const e = err as Error;
        if (!this.closed) this.port.postMessage({ k: 'err', id: msg.id, e: { name: e?.name ?? 'Error', message: e?.message ?? String(err) } } satisfies Wire);
      }
    } else if (msg.k === 'ok' || msg.k === 'err') {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (!p) return;
      if (msg.k === 'ok') p.resolve(msg.v);
      else {
        const e = new Error(msg.e.message);
        e.name = msg.e.name;
        p.reject(e);
      }
    } else if (msg.k === 'evt') {
      for (const fn of [...(this.#listeners.get(msg.n) ?? [])]) {
        try {
          (fn as (p: unknown) => void)(msg.p);
        } catch (err) {
          console.error(`[rpc] listener for "${msg.n}" threw`, err);
        }
      }
    }
  }
}
