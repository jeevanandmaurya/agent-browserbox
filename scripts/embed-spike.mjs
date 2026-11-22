// Proves the distribution boundary: a UI-less runtime page on one origin, driven
// by an ordinary app page on another origin, with no COOP/COEP on the app and
// no kernel code in the app's bundle.
//
// Dependency-free: drives the installed Chrome over CDP, so it needs no browser
// automation package.
//
// Usage: VITE_ALLOWED_ORIGINS=http://127.0.0.1:4552 npm run build && node scripts/embed-spike.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const RUNTIME_PORT = 4551;
const HOST_PORT = 4552;
const runtime = `http://127.0.0.1:${RUNTIME_PORT}`;
const host = `http://127.0.0.1:${HOST_PORT}`;

const HOST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>host app</title></head>
<body>
<script type="module">
  const runtime = ${JSON.stringify(runtime)};
  const frame = document.createElement('iframe');
  frame.src = runtime + '/embed/';
  frame.hidden = true;
  const pending = new Map();
  let next = 1;
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    frame.contentWindow.postMessage({ type: 'bbx:call', id, method, args }, runtime);
  });
  addEventListener('message', (e) => {
    if (e.origin !== runtime) return;
    const d = e.data;
    if (d?.type !== 'bbx:result') return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    d.ok ? p.resolve(d.value) : p.reject(new Error(d.error));
  });
  addEventListener('message', async (e) => {
    if (e.origin !== runtime || e.data?.type !== 'bbx:embed-ready') return;
    try {
      const info = await call('info');
      await call('fs.writeFile', '/home/user/spike.txt', 'hello from the host app');
      const text = await call('fs.readText', '/home/user/spike.txt');
      const sh = await call('shell.run', 'cat /home/user/spike.txt && echo SPIKE_OK');
      globalThis.__spike = { info, text, sh, isolated: crossOriginIsolated };
    } catch (err) {
      globalThis.__spike = { error: err.message };
    }
  });
  document.body.append(frame);
</script>
</body></html>`;

const CHROME = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP session: enough to open a page, evaluate in it and see errors. */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  let id = 0;
  const waiting = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { send, errors, close: () => ws.close() };
}

let failed = 0;
const check = (name, fn) => {
  try {
    const out = fn();
    console.log(`ok   ${name}${out === undefined ? '' : ` → ${typeof out === 'string' ? out : JSON.stringify(out)}`}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
};

const hostServer = createServer((_req, res) => {
  // Deliberately no COOP/COEP: the embedding app must not need them.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HOST_PAGE);
});
await new Promise((r) => hostServer.listen(HOST_PORT, '127.0.0.1', r));
const runtimeServer = spawn(process.execPath, ['bin/browserbox.mjs', '--port', String(RUNTIME_PORT), '--no-open'], { stdio: 'ignore' });

const profile = await mkdtemp(join(tmpdir(), 'bbx-spike-'));
const chrome = CHROME
  ? spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' })
  : null;

try {
  if (!chrome) throw new Error('no Chrome or Edge found');
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then((s) => s.split('\n')[0].trim()).catch(() => undefined);
    if (!port) await sleep(100);
  }
  if (!port) throw new Error('Chrome did not expose a debugging port');

  const opened = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(host)}`, { method: 'PUT' }).then((r) => r.json());
  const page = opened.webSocketDebuggerUrl ? opened : (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error(`cannot open a page: ${JSON.stringify(opened)}`);
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const deadline = Date.now() + 90000;
  let raw;
  while (Date.now() < deadline) {
    const out = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__spike ?? null)', returnByValue: true });
    raw = out.result.value;
    if (raw && raw !== 'null') break;
    await sleep(250);
  }
  if (!raw) throw new Error('the host page never finished the spike');

  const s = JSON.parse(raw);
  if (s.error) throw new Error(s.error);

  check('host page is not cross-origin isolated', () => {
    if (s.isolated) throw new Error('host reported crossOriginIsolated=true');
    return 'crossOriginIsolated=false';
  });
  check('runtime reports kernel info', () => {
    if (!s.info?.version) throw new Error(`no version: ${JSON.stringify(s.info)}`);
    return `v${s.info.version}, root=${s.info.rootKind}, caps=${s.info.caps.length}`;
  });
  check('host writes a file through the runtime', () => {
    if (s.text !== 'hello from the host app') throw new Error(`read back ${JSON.stringify(s.text)}`);
    return 'round-tripped';
  });
  check('host runs a shell command through the runtime', () => {
    if (s.sh.code !== 0) throw new Error(`exit ${s.sh.code}: ${s.sh.err}`);
    if (!s.sh.out.includes('SPIKE_OK')) throw new Error(`unexpected output ${JSON.stringify(s.sh.out)}`);
    return JSON.stringify(s.sh.out.trim());
  });
  if (cdp.errors.length) {
    failed++;
    for (const e of cdp.errors) console.log(`FAIL console: ${e}`);
  }
  cdp.close();
} catch (err) {
  failed++;
  console.log(`FAIL spike: ${err.message}`);
}

chrome?.kill();
runtimeServer.kill();
hostServer.close();
await rm(profile, { recursive: true, force: true }).catch(() => undefined);
console.log(failed ? `\n${failed} failure(s)` : '\nembed spike passed');
process.exit(failed ? 1 : 0);
