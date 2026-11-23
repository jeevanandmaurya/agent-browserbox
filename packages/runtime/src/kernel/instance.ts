/**
 * Which kernel this is. The app has one kernel per site (`APP_KERNEL`); every
 * SDK box has its own, with its own files, settings and secrets. The identity
 * travels from the SDK to the runtime page's URL (`embed/?box=…`), to the
 * bridge's URL, and into the worker's name, which the kernel reads at startup.
 */
export interface KernelInstance {
  /** Null for the app's own kernel; a box id otherwise. */
  box: string | null;
  /** 'opfs': files and settings persist. 'memory': nothing outlives the box. */
  storage: 'opfs' | 'memory';
}

export const APP_KERNEL: KernelInstance = { box: null, storage: 'opfs' };

/** Box ids: letters, digits, '-' and '_', up to 64 characters. */
export const BOX_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function workerName(k: KernelInstance): string {
  return k.box === null ? 'bbx-kernel' : `bbx-box:${k.storage}:${k.box}`;
}

export function fromWorkerName(name: string): KernelInstance {
  const m = /^bbx-box:(opfs|memory):([A-Za-z0-9_-]{1,64})$/.exec(name);
  return m ? { box: m[2]!, storage: m[1] as KernelInstance['storage'] } : APP_KERNEL;
}

/** Reads a box from URL parameters (`?box=<id>&storage=memory`); the app's kernel when there is none. */
export function fromSearch(search: string): KernelInstance {
  const q = new URLSearchParams(search);
  const box = q.get('box');
  if (box === null) return APP_KERNEL;
  if (!BOX_ID.test(box)) throw new Error(`invalid box id: ${box}`);
  return { box, storage: q.get('storage') === 'memory' ? 'memory' : 'opfs' };
}

export function toSearch(k: KernelInstance): string {
  return k.box === null ? '' : `?box=${encodeURIComponent(k.box)}&storage=${k.storage}`;
}

/** IndexedDB database name for this kernel's copy of a store; null when nothing may persist. */
export function dbName(base: string, k: KernelInstance): string | null {
  if (k.storage === 'memory') return null;
  return k.box === null ? base : `${base}:box:${k.box}`;
}
