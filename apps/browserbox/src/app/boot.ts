import { BrowserBox, VERSION as RUNTIME_VERSION } from '@jeevanand/agent-browserbox-sdk';
import { DEFAULT_PROFILE, getProfile, lastProfile, RemoteKernel, setLastProfile } from '@jeevanand/agent-browserbox-runtime/client';
import { AgentClient } from './agent-client';
import { attachAgents } from './agents';

/**
 * How a BrowserBox app window starts. The app is a client of the released
 * packages: it boots the runtime release through the SDK, on the site's own
 * kernel (`site: true`, so files, settings and keys are where they always
 * were), drives the kernel through the SDK's kernel channel, and runs the
 * agent package in its agent worker.
 */

/**
 * Where the runtime is served: the release of the SDK's own version, next to
 * the app (`/runtime/<version>/`). The development server serves the built
 * runtime package there too (npm run build:runtime first).
 */
export const RUNTIME_URL: string =
  import.meta.env.VITE_RUNTIME_URL || new URL(`../runtime/${RUNTIME_VERSION}/`, location.href).href;

/** The profile of this tab, kept across its reloads. */
const TAB_KEY = 'bbx-profile';
const tabProfile = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(TAB_KEY);
    } catch {
      return null;
    }
  },
  set: (id: string): void => {
    try {
      sessionStorage.setItem(TAB_KEY, id);
    } catch {
      /* private mode: the URL carries it instead */
    }
  },
};

let current: string | null = null;

/**
 * The profile this window opens: the one its URL names (`?profile=<id>`, which
 * every window the app opens carries), else the one this tab had before a
 * reload, else, in a brand-new tab, the one this browser used last.
 */
export const PROFILE: Promise<string> = (async () => {
  const known = async (id: string | null) => (id && (await getProfile(id).catch(() => null)) ? id : null);
  const id = (await known(new URLSearchParams(location.search).get('profile'))) ?? (await known(tabProfile.get())) ?? (await lastProfile().catch(() => DEFAULT_PROFILE));
  current = id;
  tabProfile.set(id);
  await setLastProfile(id).catch(() => undefined);
  return id;
})();

/**
 * A URL of the app for the same profile as this window, so a tab or window
 * opened from here belongs to the same person (and their signed-in keys).
 */
export function withProfile(url: string): string {
  if (!current) return url;
  const u = new URL(url, location.href);
  u.searchParams.set('profile', current);
  return u.href;
}

/** A window name of this profile's own: another profile's window is never reused. */
export const profileWindow = (name: string): string => (current && current !== DEFAULT_PROFILE ? `${name}:${current}` : name);

/** Opens another profile in this tab. */
export async function switchProfile(id: string): Promise<void> {
  tabProfile.set(id);
  await setLastProfile(id);
  const url = new URL(location.href);
  url.searchParams.set('profile', id);
  location.replace(url);
}

/** Each profile's agents run in a worker of their own, with that profile's keys. */
const agentWorkerName = (profile: string) => (profile === DEFAULT_PROFILE ? 'bbx-agent' : `bbx-agent:${profile}`);

/** Starts (or joins) the profile's agent worker and returns a port to it. */
function agentWorkerPort(profile: string): MessagePort {
  const name = agentWorkerName(profile);
  if ('SharedWorker' in globalThis) return new SharedWorker(new URL('./agent-worker.ts', import.meta.url), { type: 'module', name }).port;
  // No SharedWorker (some mobile browsers): one agent worker per window.
  const worker = new Worker(new URL('./agent-worker.ts', import.meta.url), { type: 'module', name });
  const ch = new MessageChannel();
  worker.postMessage({ type: 'connect' }, [ch.port2]);
  return ch.port1;
}

/** This window's handle on the kernel, with agent calls going to the agent worker. */
export function appKernel(): RemoteKernel {
  const box = PROFILE.then((profile) => BrowserBox.boot({ runtimeUrl: RUNTIME_URL, site: true, profile, timeoutMs: 60_000 }));
  const os = new RemoteKernel(box.then((b) => b.kernelPort()));

  // Held while this window lives; the agent worker watches it to learn that the window closed.
  const lock = `bbx-app-window-${crypto.randomUUID()}`;
  void navigator.locks?.request(lock, () => new Promise(() => undefined));
  const port = PROFILE.then((profile) => {
    const p = agentWorkerPort(profile);
    // The agent works in the box this window booted: lend it a connection when it asks.
    p.addEventListener('message', (e: MessageEvent<{ k?: string; n?: string }>) => {
      if (e.data?.k !== 'evt' || e.data.n !== 'box:need') return;
      void box
        .then((b) => b.share())
        .then((shared) => p.postMessage({ k: 'evt', n: 'box', p: shared }, [shared]));
    });
    return p;
  });
  attachAgents(os, new AgentClient(port, os, lock));
  return os;
}
