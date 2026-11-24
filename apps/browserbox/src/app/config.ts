/**
 * Where each part of the BrowserBox app is served from. By default they are
 * sibling paths under one origin (/agent/, /os/, /docs/, /preview/). To put
 * them on origins of their own, build with VITE_AGENT_URL, VITE_OS_URL,
 * VITE_DOCS_URL and VITE_PREVIEW_URL. (The runtime's own locations are the
 * runtime's business: see RUNTIME_URL in boot.ts.)
 */
const env = import.meta.env;
const here = (rel: string) => new URL(rel, globalThis.location?.href ?? 'http://localhost/').href;

/** The agent window. */
export const AGENT_URL: string = env.VITE_AGENT_URL || here('../agent/');
/** The documentation, a page of its own. */
export const DOCS_URL: string = env.VITE_DOCS_URL || here('../docs/');
/** One app in a tab of its own (app/?app=<id>&args=<json>). */
export const APP_URL: string = env.VITE_APP_URL || here('../app/');
/** The optional desktop GUI. */
export const OS_URL: string = env.VITE_OS_URL || here('../os/');

/**
 * Pages shown in Preview (agent-made pages, dev servers) load into a frame
 * served from here, sandboxed to an opaque origin. Give it its own origin
 * (VITE_PREVIEW_URL=https://preview.example.com/) once you have a domain.
 */
export const PREVIEW_URL: string = env.VITE_PREVIEW_URL || here('../preview/');
export const PREVIEW_FRAME_URL = new URL('frame.html', PREVIEW_URL).href;
