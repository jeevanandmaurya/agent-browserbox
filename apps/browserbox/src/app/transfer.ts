import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';

/**
 * Sends a folder from this BrowserBox to another device's, directly (WebRTC),
 * with no server in between: the two devices swap a code each (copy and paste,
 * or any messenger). On the same network nothing else is needed; across
 * networks, a public STUN server helps the devices find each other (it learns
 * their public addresses, not the files).
 */
const PREFIX = 'BBX1.';
const CHUNK = 16 * 1024;
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
/** Received folders land here, each in its own folder. */
export const RECEIVED_DIR = '/home/user/Received';

export const transferAvailable = (): boolean => typeof RTCPeerConnection !== 'undefined' && typeof CompressionStream !== 'undefined';

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function encode(d: RTCSessionDescriptionInit): Promise<string> {
  return PREFIX + b64url(await pipe(new TextEncoder().encode(JSON.stringify({ t: d.type, s: d.sdp })), new CompressionStream('deflate-raw')));
}
async function decode(code: string, want: RTCSdpType): Promise<RTCSessionDescriptionInit> {
  const c = code.replace(/\s+/g, '');
  if (!c.startsWith(PREFIX)) throw new Error('That is not a BrowserBox transfer code.');
  let d: { t: RTCSdpType; s: string };
  try {
    d = JSON.parse(new TextDecoder().decode(await pipe(unb64url(c.slice(PREFIX.length)), new DecompressionStream('deflate-raw'))));
  } catch {
    throw new Error('The code is incomplete: copy all of it.');
  }
  if (d.t !== want) throw new Error(want === 'offer' ? 'That is a reply code: paste it on the sending device.' : 'That is a sending code: paste it on the receiving device.');
  return { type: d.t, sdp: d.s };
}

/** Waits until the connection has found its addresses (they go in the code). */
function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 6000);
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && (clearTimeout(t), resolve()));
  });
}

export interface Progress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  name: string;
}

type Control = { t: 'start'; folder: string; files: number; bytes: number } | { t: 'file'; path: string; size: number } | { t: 'done' };

/** The sending side: make a code, take the reply, send the folder. */
export class Sender {
  readonly pc: RTCPeerConnection;
  #dc: RTCDataChannel;

  constructor(private os: Kernel, opts: { stun?: boolean } = {}) {
    this.pc = new RTCPeerConnection({ iceServers: opts.stun ? STUN : [] });
    this.#dc = this.pc.createDataChannel('bbx-transfer', { ordered: true });
    this.#dc.binaryType = 'arraybuffer';
  }

  /** The code to give the other device. */
  async code(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gathered(this.pc);
    return encode(this.pc.localDescription!);
  }

  /** Connects with the other device's reply code and sends `folder`; resolves when it confirmed receipt. */
  async send(reply: string, folder: string, onProgress: (p: Progress) => void): Promise<Progress> {
    await this.pc.setRemoteDescription(await decode(reply, 'answer'));
    const dc = this.#dc;
    await new Promise<void>((resolve, reject) => {
      if (dc.readyState === 'open') return resolve();
      const t = setTimeout(() => reject(new Error('The devices could not connect. On different networks, tick “Use a public STUN server” on both, and make new codes.')), 20000);
      dc.onopen = () => (clearTimeout(t), resolve());
    });
    const files: Array<{ path: string; rel: string; size: number }> = [];
    const root = folder.replace(/\/+$/, '') || '/';
    const st = await this.os.fs.stat(root);
    if (!st) throw new Error(`${root} does not exist`);
    if (st.kind === 'file') files.push({ path: root, rel: root.split('/').pop()!, size: st.size });
    else for await (const s of this.os.fs.walk(root)) if (s.kind === 'file') files.push({ path: s.path, rel: s.path.slice(root.length + 1), size: s.size });
    const total: Progress = { files: 0, totalFiles: files.length, bytes: 0, totalBytes: files.reduce((n, f) => n + f.size, 0), name: '' };
    const ctl = (m: Control) => dc.send(JSON.stringify(m));
    const room = () =>
      dc.bufferedAmount < 1 << 20
        ? Promise.resolve()
        : new Promise<void>((r) => {
            dc.bufferedAmountLowThreshold = 256 * 1024;
            dc.onbufferedamountlow = () => r();
          });
    const received = new Promise<void>((resolve, reject) => {
      dc.onmessage = (e) => typeof e.data === 'string' && JSON.parse(e.data).t === 'received' && resolve();
      dc.onclose = () => reject(new Error('The other device closed the connection.'));
    });
    ctl({ t: 'start', folder: root.split('/').pop() || 'files', files: total.totalFiles, bytes: total.totalBytes });
    for (const f of files) {
      const data = await this.os.fs.readFile(f.path);
      ctl({ t: 'file', path: f.rel, size: data.length });
      total.name = f.rel;
      for (let i = 0; i < data.length; i += CHUNK) {
        await room();
        dc.send(data.slice(i, i + CHUNK));
        total.bytes += Math.min(CHUNK, data.length - i);
        onProgress({ ...total });
      }
      total.files++;
      onProgress({ ...total });
    }
    ctl({ t: 'done' });
    await received;
    this.close();
    return total;
  }

  close(): void {
    this.#dc.close();
    this.pc.close();
  }
}

/** The receiving side: take the code, make a reply, save what arrives under ~/Received. */
export class Receiver {
  readonly pc: RTCPeerConnection;

  constructor(private os: Kernel, opts: { stun?: boolean } = {}) {
    this.pc = new RTCPeerConnection({ iceServers: opts.stun ? STUN : [] });
  }

  /** The reply code for the sending device. */
  async reply(code: string): Promise<string> {
    await this.pc.setRemoteDescription(await decode(code, 'offer'));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc);
    return encode(this.pc.localDescription!);
  }

  /** Resolves with the folder the files were saved in once all arrived. */
  receive(onProgress: (p: Progress) => void): Promise<{ dir: string; progress: Progress }> {
    return new Promise((resolve, reject) => {
      this.pc.ondatachannel = ({ channel: dc }) => {
        dc.binaryType = 'arraybuffer';
        let dir = '';
        let current: { path: string; size: number; parts: Uint8Array[]; got: number } | null = null;
        const p: Progress = { files: 0, totalFiles: 0, bytes: 0, totalBytes: 0, name: '' };
        let writing = Promise.resolve();
        const save = (f: NonNullable<typeof current>) => {
          const data = new Uint8Array(f.got);
          let at = 0;
          for (const c of f.parts) data.set(c, (at += c.length) - c.length);
          // Paths stay inside the folder made for this transfer.
          const safe = f.path.split('/').filter((s) => s && s !== '.' && s !== '..').join('/') || 'file';
          const path = `${dir}/${safe}`;
          writing = writing.then(async () => {
            await this.os.fs.mkdir(path.slice(0, path.lastIndexOf('/'))).catch(() => undefined);
            await this.os.fs.writeFile(path, data);
          });
        };
        dc.onmessage = async (e) => {
          if (typeof e.data !== 'string') {
            if (!current) return;
            const chunk = new Uint8Array(e.data as ArrayBuffer);
            current.parts.push(chunk);
            current.got += chunk.length;
            p.bytes += chunk.length;
            if (current.got >= current.size) {
              save(current);
              current = null;
              p.files++;
            }
            onProgress({ ...p });
            return;
          }
          const m = JSON.parse(e.data) as Control;
          if (m.t === 'start') {
            const name = m.folder.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'files';
            for (let i = 0; ; i++) {
              dir = `${RECEIVED_DIR}/${i ? `${name}-${i}` : name}`;
              if (!(await this.os.fs.exists(dir))) break;
            }
            await this.os.fs.mkdir(dir);
            Object.assign(p, { totalFiles: m.files, totalBytes: m.bytes });
          } else if (m.t === 'file') {
            current = { path: m.path, size: m.size, parts: [], got: 0 };
            p.name = m.path;
            if (m.size === 0) {
              save(current);
              current = null;
              p.files++;
            }
          } else if (m.t === 'done') {
            try {
              await writing;
              dc.send(JSON.stringify({ t: 'received' }));
              resolve({ dir, progress: { ...p } });
              setTimeout(() => this.pc.close(), 1000);
            } catch (err) {
              reject(err);
            }
          }
        };
        dc.onclose = () => (p.files < p.totalFiles || !dir) && reject(new Error('The connection closed before everything arrived.'));
      };
    });
  }

  close(): void {
    this.pc.close();
  }
}
