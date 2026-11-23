import type { KernelCore } from '../kernel';
import type { DevServers } from './server';
import type { DevApi, DevInfo, DevLog, DevPage, DevStartOptions, WireRequest, WireResponse } from './types';

/**
 * The dev servers, loaded on first use: the bundler, page builder and in-page
 * runtime are not needed to boot, only when something is served.
 */
export class LazyDev implements DevApi {
  #impl: Promise<DevServers> | null = null;

  constructor(private os: KernelCore) {}

  #get(): Promise<DevServers> {
    this.#impl ??= import('./server').then((m) => new m.DevServers(this.os));
    return this.#impl;
  }

  start(o: DevStartOptions): Promise<DevInfo> {
    return this.#get().then((d) => d.start(o));
  }
  async stop(port: number): Promise<boolean> {
    return this.#impl ? (await this.#impl).stop(port) : false;
  }
  async list(): Promise<DevInfo[]> {
    return this.#impl ? (await this.#impl).list() : [];
  }
  page(port: number, path?: string): Promise<DevPage> {
    return this.#get().then((d) => d.page(port, path));
  }
  request(port: number, req: WireRequest): Promise<WireResponse> {
    return this.#get().then((d) => d.request(port, req));
  }
  log(port: number, entries: Array<Pick<DevLog, 'level' | 'source' | 'text'>>): void {
    void this.#impl?.then((d) => d.log(port, entries));
  }
  async logs(port: number, opts?: { after?: number; limit?: number }): Promise<DevLog[]> {
    if (!this.#impl) throw new Error(`nothing is serving on port ${port} (see: serve list)`);
    return (await this.#impl).logs(port, opts);
  }
}
