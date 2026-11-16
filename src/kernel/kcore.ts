import wasmUrl from './kcore.wasm?url';

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  fnv1a64(ptr: number, len: number): bigint;
  search_lines(hay: number, hayLen: number, needle: number, needleLen: number, flags: number, out: number, cap: number): number;
  wc(ptr: number, len: number, out: number): void;
  estimate_tokens(ptr: number, len: number): number;
}

export interface LineMatch {
  line: number;
  offset: number;
}

const enc = new TextEncoder();

/**
 * Bindings for the Rust kernel core (crates/kcore). Loaded lazily with
 * streaming compilation; every entry point has a pure-JS fallback so the OS
 * still works where WebAssembly is disabled.
 */
export class KCore {
  #x: Exports | null = null;
  #loading: Promise<void> | null = null;

  get loaded(): boolean {
    return this.#x !== null;
  }

  load(): Promise<void> {
    return (this.#loading ??= (async () => {
      try {
        const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
        this.#x = instance.exports as unknown as Exports;
      } catch (err) {
        console.warn('[kcore] wasm unavailable, using JS fallbacks', err);
      }
    })());
  }

  #with<T>(data: Uint8Array, fn: (x: Exports, ptr: number) => T): T {
    const x = this.#x!;
    const ptr = x.alloc(data.length);
    try {
      new Uint8Array(x.memory.buffer, ptr, data.length).set(data);
      return fn(x, ptr);
    } finally {
      x.dealloc(ptr, data.length);
    }
  }

  hash(data: Uint8Array): string {
    if (this.#x) return this.#with(data, (x, p) => BigInt.asUintN(64, x.fnv1a64(p, data.length)).toString(16).padStart(16, '0'));
    let h = 0xcbf29ce484222325n;
    for (const b of data) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
    return h.toString(16).padStart(16, '0');
  }

  /** Literal search returning matching line numbers and byte offsets. */
  searchLines(hay: Uint8Array, needle: string, ignoreCase = false, cap = 1000): { total: number; matches: LineMatch[] } {
    const n = enc.encode(needle);
    if (this.#x) {
      return this.#with(hay, (x, hp) => {
        const np = x.alloc(n.length);
        const op = x.alloc(cap * 8);
        try {
          new Uint8Array(x.memory.buffer, np, n.length).set(n);
          const total = x.search_lines(hp, hay.length, np, n.length, ignoreCase ? 1 : 0, op, cap);
          const view = new DataView(x.memory.buffer, op, cap * 8);
          const matches: LineMatch[] = [];
          for (let i = 0; i < Math.min(total, cap); i++) matches.push({ line: view.getUint32(i * 8, true), offset: view.getUint32(i * 8 + 4, true) });
          return { total, matches };
        } finally {
          x.dealloc(np, n.length);
          x.dealloc(op, cap * 8);
        }
      });
    }
    const text = new TextDecoder().decode(hay);
    const q = ignoreCase ? needle.toLowerCase() : needle;
    const matches: LineMatch[] = [];
    let total = 0;
    let offset = 0;
    text.split('\n').forEach((line, i) => {
      if ((ignoreCase ? line.toLowerCase() : line).includes(q)) {
        if (matches.length < cap) matches.push({ line: i + 1, offset });
        total++;
      }
      offset += enc.encode(line).length + 1;
    });
    return { total, matches };
  }

  wc(data: Uint8Array): { lines: number; words: number; bytes: number } {
    if (this.#x) {
      return this.#with(data, (x, p) => {
        const out = x.alloc(12);
        try {
          x.wc(p, data.length, out);
          const v = new DataView(x.memory.buffer, out, 12);
          return { lines: v.getUint32(0, true), words: v.getUint32(4, true), bytes: v.getUint32(8, true) };
        } finally {
          x.dealloc(out, 12);
        }
      });
    }
    const text = new TextDecoder().decode(data);
    return { lines: (text.match(/\n/g) ?? []).length, words: (text.match(/\S+/g) ?? []).length, bytes: data.length };
  }

  estimateTokens(text: string): number {
    if (this.#x) {
      const data = enc.encode(text);
      return this.#with(data, (x, p) => x.estimate_tokens(p, data.length));
    }
    return Math.ceil(text.length / 3.6);
  }
}
