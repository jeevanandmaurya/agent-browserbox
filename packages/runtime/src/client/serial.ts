/**
 * Serial devices (Web Serial: microcontrollers, modems, lab instruments), run in
 * a window: the kernel's `serial` command reaches them through the window that
 * answers its UI calls. A device must first be granted by a person (a click in
 * Settings → Devices); after that, granted devices are listed without asking.
 */
export interface SerialPortInfo {
  /** Stable while the page is open: its place in the granted list. */
  index: number;
  label: string;
  open: boolean;
  baudRate?: number;
}

type Port = {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
};
type SerialApi = { getPorts(): Promise<Port[]>; requestPort(o?: object): Promise<Port> };
const api = (): SerialApi | null => ((globalThis.navigator as unknown as { serial?: SerialApi } | undefined)?.serial ?? null);
export const serialAvailable = (): boolean => api() !== null;

const MAX_BUFFER = 1 << 20;
const hex = (n?: number) => (n === undefined ? '????' : n.toString(16).padStart(4, '0'));

interface OpenPort {
  port: Port;
  baudRate: number;
  received: Uint8Array[];
  size: number;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  closed: Promise<void>;
}

export class SerialHost {
  #open = new Map<Port, OpenPort>();

  async #ports(): Promise<Port[]> {
    const s = api();
    if (!s) throw new Error('This browser has no Web Serial (Chrome, Edge or Opera on a computer have it).');
    return s.getPorts();
  }

  async #port(index: number): Promise<Port> {
    const p = (await this.#ports())[index];
    if (!p) throw new Error(`no serial device #${index}: run serial list (a device is connected once in Settings → Devices)`);
    return p;
  }

  /** Asks the person to pick a device (needs a click). */
  async grant(): Promise<SerialPortInfo> {
    const s = api();
    if (!s) throw new Error('This browser has no Web Serial.');
    const port = await s.requestPort();
    const all = await s.getPorts();
    return this.#info(port, all.indexOf(port));
  }

  #info(port: Port, index: number): SerialPortInfo {
    const i = port.getInfo();
    const o = this.#open.get(port);
    return { index, label: i.usbVendorId !== undefined ? `USB ${hex(i.usbVendorId)}:${hex(i.usbProductId)}` : 'Serial port', open: !!o, baudRate: o?.baudRate };
  }

  async list(): Promise<SerialPortInfo[]> {
    return (await this.#ports()).map((p, i) => this.#info(p, i));
  }

  async open(index: number, baudRate = 115200): Promise<SerialPortInfo> {
    const port = await this.#port(index);
    const was = this.#open.get(port);
    if (was && was.baudRate === baudRate) return this.#info(port, index);
    if (was) await this.close(index);
    await port.open({ baudRate });
    const o: OpenPort = { port, baudRate, received: [], size: 0, reader: null, closed: Promise.resolve() };
    // Registered first: the read loop runs only while this port is the open one.
    this.#open.set(port, o);
    o.closed = (async () => {
      while (port.readable && this.#open.get(port) === o) {
        o.reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await o.reader.read();
            if (done) break;
            o.received.push(value);
            o.size += value.length;
            while (o.size > MAX_BUFFER && o.received.length > 1) o.size -= o.received.shift()!.length;
          }
        } catch {
          // A read error (e.g. a framing error) ends this reader; the loop takes a new one.
        } finally {
          o.reader.releaseLock();
        }
      }
    })();
    return this.#info(port, index);
  }

  async send(index: number, data: string | Uint8Array, baudRate?: number): Promise<number> {
    const port = await this.#port(index);
    if (!this.#open.has(port)) await this.open(index, baudRate);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const writer = port.writable!.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
    return bytes.length;
  }

  /** Waits up to `ms` for data, then returns (and clears) what arrived. */
  async read(index: number, ms = 1000, baudRate?: number): Promise<string> {
    const port = await this.#port(index);
    if (!this.#open.has(port)) await this.open(index, baudRate);
    const o = this.#open.get(port)!;
    const until = Date.now() + Math.max(0, Math.min(ms, 60_000));
    while (!o.size && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    // A little longer while data keeps arriving, so a line is not cut in two.
    for (let last = o.size; Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 50));
      if (o.size === last) break;
      last = o.size;
    }
    const all = new Uint8Array(o.size);
    let at = 0;
    for (const c of o.received) all.set(c, (at += c.length) - c.length);
    o.received = [];
    o.size = 0;
    return new TextDecoder().decode(all);
  }

  async close(index: number): Promise<void> {
    const port = await this.#port(index);
    const o = this.#open.get(port);
    if (!o) return;
    this.#open.delete(port);
    await o.reader?.cancel().catch(() => undefined);
    await o.closed.catch(() => undefined);
    await port.close().catch(() => undefined);
  }

  /** Removes the permission for a device. */
  async forget(index: number): Promise<void> {
    await this.close(index).catch(() => undefined);
    const port = await this.#port(index);
    await port.forget?.();
  }

  /** The kernel's UI calls (`serial.*`). */
  call(method: string, args: unknown[]): Promise<unknown> | null {
    const n = Number(args[0]);
    switch (method) {
      case 'serial.list':
        return this.list();
      case 'serial.open':
        return this.open(n, args[1] as number | undefined);
      case 'serial.send':
        return this.send(n, args[1] as string, args[2] as number | undefined);
      case 'serial.read':
        return this.read(n, args[1] as number | undefined, args[2] as number | undefined);
      case 'serial.close':
        return this.close(n);
      default:
        return null;
    }
  }
}
