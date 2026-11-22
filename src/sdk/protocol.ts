/**
 * The wire protocol between the SDK (in the embedding app) and the runtime page
 * (embed/, served with the kernel). The SDK posts `bbx:sdk-hello` with a
 * MessagePort to the runtime frame; everything after goes over that port.
 *
 * Bump PROTOCOL when a message changes shape. The runtime answers older
 * clients it still understands and refuses the rest with a clear message.
 */
export const PROTOCOL = 1;

/** SDK → runtime. */
export type ClientMsg =
  | { t: 'call'; id: number; m: string; a: unknown[] }
  /** The answer to an `ask` (a permission or a question from the agent). */
  | { t: 'answer'; id: number; v: unknown };

/** Runtime → SDK. */
export type RuntimeMsg =
  | { t: 'ready'; info: RuntimeInfo }
  | { t: 'res'; id: number; ok: true; v: unknown }
  | { t: 'res'; id: number; ok: false; e: string; code?: string }
  /** A stream event: `ch` is `proc:<id>` or `agent:<sid>`. */
  | { t: 'ev'; ch: string; d: unknown }
  | { t: 'ask'; id: number; kind: 'perm' | 'question'; sid?: string; payload: unknown };

export interface RuntimeInfo {
  protocol: number;
  version: string;
  /** opfs: files persist (per embedding site); memory: lost when the page closes. */
  storage: 'opfs' | 'memory';
  /** True when the runtime frame is cross-origin isolated (SharedArrayBuffer, WebContainers / real Node.js). */
  isolated: boolean;
  /** Platform features the browser has (webgpu, opfs, sharedworker…). */
  caps: string[];
  home: string;
}

/** A process's output and end, sent as `ev` on `proc:<id>`. */
export type ProcEvent = { k: 'out'; s: string } | { k: 'err'; s: string } | { k: 'exit'; code: number };
