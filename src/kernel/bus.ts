/** Typed synchronous event bus — the kernel's only cross-module coupling. */
export class Bus<Events extends Record<string, unknown>> {
  #subs = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.#subs.get(type);
    if (!set) this.#subs.set(type, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => set.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.#subs.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (payload: Events[K]) => void)(payload);
      } catch (err) {
        console.error(`[bus] handler for "${String(type)}" threw`, err);
      }
    }
  }
}
