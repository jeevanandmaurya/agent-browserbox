import type { Command, CommandContext } from '../shell';

/**
 * `serial`: talk to a serial device (a microcontroller, a modem, an
 * instrument) through Web Serial. A person connects a device once in
 * Settings → Devices; then the shell (and the agent, with your approval of
 * its command) can list, open, send to and read from it.
 */
const USAGE = `usage: serial list
       serial open N [--baud 115200]
       serial send N text… [--baud 115200] [--raw]   (adds \\r\\n unless --raw; \\n, \\r, \\t, \\xHH work)
       serial read N [--ms 1000]
       serial monitor N [--baud 115200]              (until Ctrl+C)
       serial close N`;

type Wire<T> = { ok?: T; error?: string } | string | null;

async function call<T>(ctx: CommandContext, method: 'serial.list' | 'serial.open' | 'serial.send' | 'serial.read' | 'serial.close', ...args: unknown[]): Promise<T> {
  const ui = (ctx.os as unknown as { ui?: { call<R>(m: string, ...a: unknown[]): Promise<R> } | null }).ui;
  if (!ui) throw new Error('serial devices need a BrowserBox window open (they are reached through it)');
  const r = await ui.call<Wire<T>>(method, ...args);
  if (r && typeof r === 'object' && 'error' in r && r.error) throw new Error(r.error);
  if (r && typeof r === 'object' && 'ok' in r) return r.ok as T;
  throw new Error(typeof r === 'string' ? r.replace(/^failed: /, '') : 'no window could reach the serial device');
}

const unescape = (s: string) => s.replace(/\\(x[0-9a-fA-F]{2}|[nrt\\])/g, (_, c: string) => (c[0] === 'x' ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : '\\'));

/** Code run for someone else (an SDK client) asks before reaching a device. */
async function gate(ctx: CommandContext, what: string): Promise<void> {
  if (!ctx.shell.confined) return;
  const ok = await ctx.os.perms.request({ cap: 'exec', actor: 'serial', title: 'Use a serial device', detail: what }, ctx.shell.prompter);
  if (!ok) throw new Error('using the serial device was not allowed');
}

export const serialCommand: Command = {
  name: 'serial',
  summary: 'talk to a serial device (Web Serial): list, open, send, read, monitor',
  usage: USAGE,
  async run(ctx) {
    const { out } = ctx;
    const args = [...ctx.args];
    const opt = (name: string): string | undefined => {
      const i = args.indexOf(name);
      if (i < 0) return undefined;
      const v = args[i + 1];
      args.splice(i, 2);
      return v;
    };
    const flag = (name: string) => {
      const i = args.indexOf(name);
      if (i >= 0) args.splice(i, 1);
      return i >= 0;
    };
    const baud = opt('--baud');
    const ms = opt('--ms');
    const raw = flag('--raw');
    const [verb = 'list', n, ...rest] = args;
    const baudRate = baud ? Number(baud) : undefined;
    if (baud && !(baudRate! > 0)) throw new Error(`bad baud rate: ${baud}`);
    const index = () => {
      const i = Number(n);
      if (!Number.isInteger(i) || i < 0) throw new Error(`which device? serial ${verb} N (see serial list)`);
      return i;
    };
    if (verb === 'help' || verb === '--help') return void out(`${USAGE}\n`);
    if (verb === 'list') {
      const ports = await call<Array<{ index: number; label: string; open: boolean; baudRate?: number }>>(ctx, 'serial.list');
      if (!ports.length) return void out('No serial devices connected. Connect one in Settings → Devices (the browser asks you to pick it).\n');
      for (const p of ports) out(`${p.index}  ${p.label}${p.open ? `  open at ${p.baudRate} baud` : ''}\n`);
      return 0;
    }
    if (verb === 'open') {
      await gate(ctx, `device #${index()}`);
      const p = await call<{ label: string; baudRate: number }>(ctx, 'serial.open', index(), baudRate);
      return void out(`opened ${p.label} at ${p.baudRate} baud\n`);
    }
    if (verb === 'send') {
      const text = unescape(rest.join(' ')) + (raw ? '' : '\r\n');
      await gate(ctx, `send to device #${index()}: ${text.trim().slice(0, 80)}`);
      const sent = await call<number>(ctx, 'serial.send', index(), text, baudRate);
      return void out(`sent ${sent} bytes\n`);
    }
    if (verb === 'read') {
      await gate(ctx, `read from device #${index()}`);
      const text = await call<string>(ctx, 'serial.read', index(), ms ? Number(ms) : 1000, baudRate);
      if (text) out(text.endsWith('\n') ? text : `${text}\n`);
      return text ? 0 : 1;
    }
    if (verb === 'monitor') {
      await gate(ctx, `read from device #${index()}`);
      await call(ctx, 'serial.open', index(), baudRate);
      out(`monitoring device #${index()} (Ctrl+C to stop)\n`);
      while (!ctx.signal?.aborted) {
        const text = await call<string>(ctx, 'serial.read', index(), 300);
        if (text) out(text);
      }
      return 0;
    }
    if (verb === 'close') {
      await call(ctx, 'serial.close', index());
      return void out('closed\n');
    }
    throw new Error(USAGE);
  },
};
