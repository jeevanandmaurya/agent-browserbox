/**
 * The virtual dev server: types shared by the kernel, the windows (over RPC),
 * the shell, the agent's tools and the Preview app.
 *
 * Nothing listens on a real port. A "port" names a server the kernel keeps for
 * a project folder; Preview asks the kernel for each page and request.
 */

export interface DevInfo {
  port: number;
  /** The project folder. */
  root: string;
  pid: number;
  /** Shown to people and the model: `http://localhost:<port>/`. Virtual; it only opens in Preview. */
  url: string;
  /** The project's request handler (`server.ts` …), relative to root, if there is one. */
  backend: string | null;
  /** Whether the backend may reach the network. */
  network: boolean;
}

export interface WireRequest {
  method: string;
  /** Path and query, e.g. `/api/todos?done=1`. */
  url: string;
  headers: Array<[string, string]>;
  body?: Uint8Array | null;
}

export interface WireResponse {
  status: number;
  statusText?: string;
  headers: Array<[string, string]>;
  body: Uint8Array | null;
}

export type DevLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface DevLog {
  /** Increasing per server; `logs({ after })` returns entries newer than this. */
  seq: number;
  /** Date.now() when recorded. */
  t: number;
  level: DevLogLevel;
  /** page: the app's console and errors · server: the backend · build: bundling · network: failed requests. */
  source: 'page' | 'server' | 'build' | 'network';
  text: string;
}

export interface DevPage {
  html: string;
  /** Build errors; the page shows them in an overlay too. */
  errors: string[];
}

export interface DevStartOptions {
  root: string;
  port?: number;
  network?: boolean;
  ppid?: number;
}

export interface DevApi {
  /** Starts a server for a folder, or returns the one already serving it. */
  start(opts: DevStartOptions): Promise<DevInfo>;
  stop(port: number): Promise<boolean>;
  list(): Promise<DevInfo[]>;
  /** Builds the page at `path` (bundling scripts and styles) for Preview to show. */
  page(port: number, path?: string): Promise<DevPage>;
  /** Answers a request the page made: a project file or the backend's response. */
  request(port: number, req: WireRequest): Promise<WireResponse>;
  /** Records what the page printed or threw. */
  log(port: number, entries: Array<Pick<DevLog, 'level' | 'source' | 'text'>>): void;
  /** Recorded output, oldest first. */
  logs(port: number, opts?: { after?: number; limit?: number }): Promise<DevLog[]>;
}
