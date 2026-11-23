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
  /**
   * For the app's kernel: which profile. Each profile is a kernel of its own,
   * with its own files, settings and keys; absent or null is the first
   * profile ("Default"), whose data is where it always was.
   */
  profile?: string | null;
}

export const APP_KERNEL: KernelInstance = { box: null, storage: 'opfs' };

/** Where boxes and other profiles keep their files, inside the first profile's OPFS root: hidden from it. */
export const HIDDEN_FOLDERS = ['boxes', 'profiles'];

/** Box ids: letters, digits, '-' and '_', up to 64 characters. */
export const BOX_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A profile of the app's kernel. */
export const profileKernel = (profile: string | null): KernelInstance => (profile ? { box: null, storage: 'opfs', profile } : APP_KERNEL);

export function workerName(k: KernelInstance): string {
  if (k.box !== null) return `bbx-box:${k.storage}:${k.box}`;
  return k.profile ? `bbx-kernel:profile:${k.profile}` : 'bbx-kernel';
}

export function fromWorkerName(name: string): KernelInstance {
  const p = /^bbx-kernel:profile:([A-Za-z0-9_-]{1,64})$/.exec(name);
  if (p) return profileKernel(p[1]!);
  const m = /^bbx-box:(opfs|memory):([A-Za-z0-9_-]{1,64})$/.exec(name);
  return m ? { box: m[2]!, storage: m[1] as KernelInstance['storage'] } : APP_KERNEL;
}

/** Reads a box from URL parameters (`?box=<id>&storage=memory`); the app's kernel when there is none. */
export function fromSearch(search: string): KernelInstance {
  const q = new URLSearchParams(search);
  const box = q.get('box');
  const profile = q.get('profile');
  if (box === null && profile) {
    if (!BOX_ID.test(profile)) throw new Error(`invalid profile id: ${profile}`);
    return profileKernel(profile);
  }
  if (box === null) return APP_KERNEL;
  if (!BOX_ID.test(box)) throw new Error(`invalid box id: ${box}`);
  return { box, storage: q.get('storage') === 'memory' ? 'memory' : 'opfs' };
}

export function toSearch(k: KernelInstance): string {
  if (k.box === null) return k.profile ? `?profile=${encodeURIComponent(k.profile)}` : '';
  return `?box=${encodeURIComponent(k.box)}&storage=${k.storage}`;
}

/** IndexedDB database name for this kernel's copy of a store; null when nothing may persist. */
export function dbName(base: string, k: KernelInstance): string | null {
  if (k.storage === 'memory') return null;
  if (k.box === null) return k.profile ? `${base}:profile:${k.profile}` : base;
  return `${base}:box:${k.box}`;
}
