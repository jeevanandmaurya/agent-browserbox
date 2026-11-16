/**
 * Where each part of BrowserBox is served from.
 *
 * By default everything lives under one origin as sibling paths
 * (`/kernel/`, `/agent/`, `/os/`). To isolate the parts on their own origins,
 * build with e.g.
 *   VITE_KERNEL_URL=https://kernel.example.com/
 *   VITE_AGENT_URL=https://agent.example.com/
 *   VITE_OS_URL=https://os.example.com/
 *   VITE_ALLOWED_ORIGINS=https://agent.example.com,https://os.example.com
 * Subdomains of one registrable domain share storage partitions, so every
 * window still reaches the same kernel. Nothing else in the code changes.
 */
const env = import.meta.env;
const here = (rel: string) => new URL(rel, globalThis.location?.href ?? 'http://localhost/').href;

/** Serves the kernel worker, the bridge frame and the sandbox frames. */
export const KERNEL_URL: string = env.VITE_KERNEL_URL || here('../kernel/');
/** The agent window. */
export const AGENT_URL: string = env.VITE_AGENT_URL || here('../agent/');
/** The optional desktop GUI. */
export const OS_URL: string = env.VITE_OS_URL || here('../os/');

/** Origins allowed to embed the kernel bridge and talk to the kernel. Empty = same origin only. */
export const ALLOWED_ORIGINS: string[] = (env.VITE_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

export const kernelOrigin = () => new URL(KERNEL_URL).origin;
