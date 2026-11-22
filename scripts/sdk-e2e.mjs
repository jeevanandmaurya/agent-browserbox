// End-to-end test of the SDK across origins, in headless Chromium:
//  - the runtime (packages/runtime/dist) is served by the runtime package's own
//    server on 127.0.0.1;
//  - an ordinary app page on localhost (a different site, no COOP/COEP) loads
//    only the SDK (packages/sdk/dist) and drives a box through it.
//
// Usage: npm run e2e:sdk   (builds the SDK and the runtime first)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK_DIST = join(ROOT, 'packages/sdk/dist');
const AGENT_DIST = join(ROOT, 'packages/agent/dist');
const { chromium } = createRequire(import.meta.url)('playwright');

const RUNTIME_PORT = 4581;
const HOST_PORT = 4582;
const runtimeUrl = `http://127.0.0.1:${RUNTIME_PORT}/`;
const hostUrl = `http://localhost:${HOST_PORT}/`;

// ---- the runtime, served by its package's CLI ----------------------------------
const runtime = spawn(process.execPath, [join(ROOT, 'packages/runtime/bin/serve.mjs'), '--port', String(RUNTIME_PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  runtime.stdout.on('data', (d) => String(d).includes('BrowserBox runtime at') && resolve());
  runtime.on('exit', (code) => reject(new Error(`runtime server exited (${code})`)));
});

// ---- an ordinary app page on another site: just the SDK, no special headers ----
const page = `<!doctype html><meta charset="utf-8"><title>host app</title>
<script type="module">
  import { BrowserBox, BoxError } from '/sdk/index.js';
  Object.assign(window, { BrowserBox, BoxError, RUNTIME: ${JSON.stringify(runtimeUrl)} });
  window.sdkLoaded = true;
</script>`;
const host = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
  // Fetched from inside the box by curl, to test network permissions.
  if (path === '/data.txt') return res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }).end('hello-from-the-network');
  if (path.startsWith('/sdk/') || path.startsWith('/agent/')) {
    const dist = path.startsWith('/sdk/') ? SDK_DIST : AGENT_DIST;
    const file = normalize(join(dist, path.slice(path.indexOf('/', 1) + 1)));
    if (!file.startsWith(dist + sep)) return res.writeHead(403).end();
    const body = await readFile(file).catch(() => null);
    if (!body) return res.writeHead(404).end();
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(body);
  }
  res.writeHead(404).end();
});
await new Promise((r) => host.listen(HOST_PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const tab = await browser.newPage();
const errors = [];
tab.on('pageerror', (e) => errors.push(e.message));
await tab.goto(hostUrl);
await tab.waitForFunction(() => window.sdkLoaded);

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`ok   ${name}${detail ? ` → ${detail}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err.message.split('\n')[0]}`);
  }
}
const run = (fn, arg) => tab.evaluate(fn, arg);

await check('boot: a page on another site starts a box with the SDK alone', () =>
  run(async () => {
    const t = performance.now();
    window.box = await BrowserBox.boot({ runtimeUrl: RUNTIME });
    if (crossOriginIsolated) throw new Error('host page should not need isolation');
    return `v${box.version}, id=${box.id}, home=${box.home}, storage=${box.storage}, ${box.caps.length} caps, ${Math.round(performance.now() - t)} ms`;
  }),
);

await check('fs: text and binary round trips, readdir, stat, rename, rm, relative paths', () =>
  run(async () => {
    const { fs } = box;
    await fs.writeFile('e2e/a.txt', 'héllo');
    if ((await fs.readTextFile(`${box.home}/e2e/a.txt`)) !== 'héllo') throw new Error('text');
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await fs.writeFile('e2e/b.bin', bytes);
    const back = await fs.readFile('e2e/b.bin');
    if (!(back instanceof Uint8Array) || back.join() !== bytes.join()) throw new Error(`binary: ${back}`);
    await fs.mkdir('e2e/sub/deeper');
    const names = (await fs.readdir('e2e')).map((s) => `${s.name}:${s.kind}`).sort().join(',');
    if (names !== 'a.txt:file,b.bin:file,sub:dir') throw new Error(`readdir: ${names}`);
    const st = await fs.stat('e2e/a.txt');
    if (st?.kind !== 'file' || st.size !== 6) throw new Error(`stat: ${JSON.stringify(st)}`);
    await fs.rename('e2e/a.txt', 'e2e/c.txt');
    if ((await fs.exists('e2e/a.txt')) || !(await fs.exists('e2e/c.txt'))) throw new Error('rename');
    await fs.rm('e2e', { recursive: true });
    if (await fs.stat('e2e')) throw new Error('rm');
    try {
      await fs.readTextFile('nope.txt');
      throw new Error('read of a missing file succeeded');
    } catch (err) {
      if (!(err instanceof BoxError) || err.code !== 'ENOENT') throw new Error(`expected ENOENT, got ${err.code}: ${err.message}`);
    }
    return names;
  }),
);

await check('exec: output, exit codes, cwd and env (with quotes)', () =>
  run(async () => {
    const a = await box.exec('echo hi && pwd');
    if (a.exitCode !== 0 || a.stdout !== `hi\n${box.home}\n`) throw new Error(JSON.stringify(a));
    await box.fs.mkdir('/tmp/work');
    const b = await box.exec('pwd', { cwd: '/tmp/work' });
    if (b.stdout.trim() !== '/tmp/work') throw new Error(JSON.stringify(b));
    const c = await box.exec('echo "$GREETING"', { env: { GREETING: `it's "quoted" $HOME` } });
    if (c.stdout !== `it's "quoted" $HOME\n`) throw new Error(JSON.stringify(c));
    const d = await box.exec('cat /does/not/exist');
    if (d.exitCode === 0 || !d.stderr) throw new Error(JSON.stringify(d));
    return `exit ${d.exitCode} with "${d.stderr.trim().slice(0, 40)}"`;
  }),
);

await check('exec: JavaScript runs in the sandbox inside the runtime', () =>
  run(async () => {
    await box.fs.writeFile('main.js', 'const n = 6 * 7; print("answer " + n); await fs.writeFile("out.txt", String(n));');
    const r = await box.exec('js main.js');
    if (r.exitCode !== 0 || !r.stdout.includes('answer 42')) throw new Error(JSON.stringify(r));
    if ((await box.fs.readTextFile('out.txt')) !== '42') throw new Error('file written by the program not found');
    return r.stdout.trim();
  }),
);

await check('spawn: output streams while the command runs', () =>
  run(async () => {
    const p = await box.spawn('echo one && sleep 0.3 && echo two');
    const chunks = [];
    const reader = p.output.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push([value, performance.now()]);
    }
    const code = await p.exit;
    const text = chunks.map((c) => c[0]).join('');
    if (code !== 0 || text !== 'one\ntwo\n') throw new Error(JSON.stringify({ code, text }));
    if (chunks.length < 2 || chunks.at(-1)[1] - chunks[0][1] < 200) throw new Error('output was not streamed');
    return `${chunks.length} chunks, ${Math.round(chunks.at(-1)[1] - chunks[0][1])} ms apart`;
  }),
);

await check('kill and timeouts', () =>
  run(async () => {
    const p = await box.spawn('sleep 30');
    await new Promise((r) => setTimeout(r, 100));
    if (!(await p.kill())) throw new Error('kill returned false');
    const killed = await p.exit;
    const t = performance.now();
    const r = await box.exec('sleep 5', { timeoutMs: 300 });
    const ms = performance.now() - t;
    if (killed !== 130 || r.exitCode !== 124 || ms > 2000) throw new Error(JSON.stringify({ killed, timeout: r.exitCode, ms }));
    return `killed → ${killed}, timed out → ${r.exitCode} after ${Math.round(ms)} ms`;
  }),
);

const dataUrl = `${hostUrl}data.txt`;
await check('permissions: network is denied by default, and each box answers for itself', () =>
  run(async (url) => {
    // Two boxes on one page: the first denies (the default), the second allows and records the request.
    const asked = [];
    const open = await BrowserBox.boot({ runtimeUrl: RUNTIME, permissions: (req) => (asked.push(req), 'once') });
    try {
      const denied = await box.exec(`curl ${url}`);
      if (denied.exitCode === 0 || !/not allowed/.test(denied.stderr)) throw new Error(`default box: ${JSON.stringify(denied)}`);
      const allowed = await open.exec(`curl ${url}`);
      if (allowed.exitCode !== 0 || allowed.stdout !== 'hello-from-the-network') throw new Error(`allowing box: ${JSON.stringify(allowed)}`);
      if (asked.length !== 1 || asked[0].cap !== 'net' || asked[0].detail !== url) throw new Error(`requests: ${JSON.stringify(asked)}`);
      return `denied: "${denied.stderr.trim()}"; allowed after a ${asked[0].cap} request from ${asked[0].actor}`;
    } finally {
      open.teardown();
    }
  }, dataUrl),
);

await check('boxes are separate machines: files, settings and permission grants', () =>
  run(async (url) => {
    const a = await BrowserBox.boot({ runtimeUrl: RUNTIME, id: 'iso-a', permissions: () => 'always' });
    const b = await BrowserBox.boot({ runtimeUrl: RUNTIME, id: 'iso-b' });
    try {
      await a.fs.writeFile('secret.txt', 'only in a');
      if (await b.fs.exists('secret.txt')) throw new Error('box b sees box a\'s file');
      if (await box.fs.exists('secret.txt')) throw new Error('the default box sees box a\'s file');
      // An 'always' grant is stored in box a's settings only.
      if ((await a.exec(`curl ${url}`)).exitCode !== 0) throw new Error('box a: curl failed');
      const inB = await b.exec(`curl ${url}`);
      if (inB.exitCode === 0) throw new Error("box a's network grant leaked into box b");
      if (a.id !== 'iso-a' || b.id !== 'iso-b') throw new Error(`ids: ${a.id}, ${b.id}`);
    } finally {
      a.teardown();
      b.teardown();
    }
    // Booting the same id again reattaches to its files.
    const again = await BrowserBox.boot({ runtimeUrl: RUNTIME, id: 'iso-a' });
    try {
      const text = await again.fs.readTextFile('secret.txt');
      if (text !== 'only in a') throw new Error(`reattached box read ${text}`);
      await again.fs.rm('secret.txt');
    } finally {
      again.teardown();
    }
    return 'a ≠ b ≠ default; grants per box; reboot of a keeps its files';
  }, dataUrl),
);

await check('in-memory boxes: own fresh id, nothing written to disk', () =>
  run(async () => {
    const m = await BrowserBox.boot({ runtimeUrl: RUNTIME, storage: 'memory' });
    const n = await BrowserBox.boot({ runtimeUrl: RUNTIME, storage: 'memory' });
    try {
      if (m.storage !== 'memory' || !m.id.startsWith('mem-') || m.id === n.id) throw new Error(JSON.stringify({ id: m.id, storage: m.storage, other: n.id }));
      await m.fs.writeFile('scratch.txt', 'temp');
      if (await n.fs.exists('scratch.txt')) throw new Error('two memory boxes share files');
      const cat = await m.exec('cat scratch.txt');
      const ls = await m.exec('ls /');
      if (cat.stdout !== 'temp') throw new Error(JSON.stringify(cat));
      if (/\x1b/.test(ls.stdout)) throw new Error(`colour codes in exec output: ${JSON.stringify(ls.stdout)}`);
      return `${m.id.slice(0, 12)}… and ${n.id.slice(0, 12)}…; ls / → ${ls.stdout.trim().replace(/\s+/g, ' ')}`;
    } finally {
      m.teardown();
      n.teardown();
    }
  }),
);

await check('invalid box ids are refused before anything loads', () =>
  run(async () => {
    try {
      await BrowserBox.boot({ runtimeUrl: RUNTIME, id: '../escape' });
      throw new Error('booted');
    } catch (err) {
      if (!(err instanceof BoxError)) throw err;
      return err.message;
    }
  }),
);

await check('shell sessions keep their folder and variables; one command at a time', () =>
  run(async () => {
    const sh = await box.openShell({ cwd: '/tmp', env: { WHO: 'session' } });
    await sh.exec('mkdir -p s1/deeper && cd s1');
    if (sh.cwd !== '/tmp/s1') throw new Error(`cwd after cd: ${sh.cwd}`);
    await sh.exec('export COLOR=blue');
    const r = await sh.exec('pwd && echo "$WHO $COLOR"');
    if (r.stdout !== '/tmp/s1\nsession blue\n') throw new Error(JSON.stringify(r));
    const long = await sh.run('sleep 30');
    try {
      await sh.run('echo too soon');
      throw new Error('a second command ran while one was running');
    } catch (err) {
      if (!/still running/.test(err.message)) throw err;
    }
    await long.kill();
    const killed = await long.exit;
    const after = await sh.exec('pwd');
    await sh.close();
    if (killed !== 130 || after.stdout.trim() !== '/tmp/s1') throw new Error(JSON.stringify({ killed, after }));
    return `cd and export persisted; killed → ${killed}; session still usable`;
  }),
);

await check('fs.glob and fs.appendFile', () =>
  run(async () => {
    await box.fs.writeFile('g/a.ts', '1');
    await box.fs.writeFile('g/sub/b.ts', '2');
    await box.fs.writeFile('g/sub/c.css', '3');
    await box.fs.appendFile('g/log.txt', 'one\n');
    await box.fs.appendFile('g/log.txt', 'two\n');
    const ts = (await box.fs.glob('**/*.ts', { cwd: 'g' })).sort().join(',');
    const log = await box.fs.readTextFile('g/log.txt');
    await box.fs.rm('g', { recursive: true });
    if (!ts.includes('a.ts') || !ts.includes('b.ts') || ts.includes('c.css') || log !== 'one\ntwo\n') throw new Error(JSON.stringify({ ts, log }));
    return `glob **/*.ts → ${ts}`;
  }),
);

await check('dev servers and the process table', () =>
  run(async () => {
    await box.fs.writeFile('site/index.html', '<!doctype html><title>t</title><h1>hi</h1>');
    const srv = await box.dev.start('site');
    const listed = (await box.dev.list()).some((d) => d.port === srv.port);
    const logs = await box.dev.logs(srv.port);
    const procs = await box.processes();
    const sleeper = await box.spawn('sleep 30');
    await new Promise((r) => setTimeout(r, 200));
    const shell = (await box.processes()).find((p) => p.kind === 'shell' && /sleep/.test(p.detail));
    const killed = shell ? await box.killProcess(shell.pid) : false;
    const code = await sleeper.exit;
    const stopped = await box.dev.stop(srv.port);
    await box.fs.rm('site', { recursive: true });
    if (!srv.url || !listed || !Array.isArray(logs) || !procs.length || !killed || code !== 130 || !stopped) throw new Error(JSON.stringify({ srv, listed, logs: logs.length, procs: procs.length, killed, code, stopped }));
    return `served ${srv.root} at ${srv.url}; ${procs.length} processes; killed a shell by pid → ${code}`;
  }),
);

await check('agent: a scripted model drives every tool against a real box', () =>
  run(async () => {
    // The agent package is optional here: SDK-only runs (its own CI and releases) do not build it.
    const { Agent } = await import('/agent/index.js').catch(() => ({}));
    if (!Agent) return 'skipped: the agent package is not built';
    const work = await BrowserBox.boot({ runtimeUrl: RUNTIME, storage: 'memory' });
    // A model that plays back a fixed script and keeps what each tool returned.
    const results = {};
    const say = (text) => ({ type: 'text', text });
    const use = (name, input) => ({ type: 'tool_use', id: name, name, input });
    const script = [
      [use('write_file', { path: 'app/main.js', content: 'const n = 6 * 7;\nprint("answer " + n);\n' }), use('todo_write', { items: [{ text: 'build', status: 'in_progress' }] })],
      [use('edit_file', { path: 'app/main.js', old_string: '6 * 7', new_string: '6 * 9' }), use('list_dir', { path: 'app' })],
      [use('glob', { pattern: '**/*.js' }), use('grep', { pattern: 'answer', path: 'app' })],
      [use('shell', { command: 'js app/main.js && echo shell-ok' }), use('run_js', { code: 'print(await fs.readText("app/main.js"))' })],
      [use('read_file', { path: 'app/main.js', offset: 2 })],
      [say('All done.')],
    ];
    let step = 0;
    const model = {
      id: 'scripted', contextWindow: 100000,
      async turn(req) {
        const last = req.messages.at(-1);
        for (const b of last.content) if (b.type === 'tool_result') results[b.tool_use_id] = (b.is_error ? 'ERROR: ' : '') + b.content;
        const content = script[step++];
        return { content, stop: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end', usage: { input: 1, output: 1, cacheRead: 0 }, model: 'scripted' };
      },
    };
    const agent = new Agent({ box: work, model, cwd: '/home/user' });
    const types = [];
    let final;
    for await (const e of agent.send('build it')) {
      types.push(e.type);
      if (e.type === 'done') final = e;
    }
    work.teardown();
    const expect = (name, ok) => { if (!ok) throw new Error(`${name}: ${JSON.stringify(results[name])}`); };
    expect('write_file', /Wrote \/home\/user\/app\/main\.js/.test(results.write_file));
    expect('todo_write', /0\/1 done/.test(results.todo_write));
    expect('edit_file', /Edited/.test(results.edit_file));
    expect('list_dir', /^main\.js {2}\d+ B$/.test(results.list_dir));
    expect('glob', results.glob === 'app/main.js');
    expect('grep', /main\.js:2:print\("answer " \+ n\);/.test(results.grep));
    expect('shell', results.shell === 'answer 54\nshell-ok');
    expect('run_js', results.run_js.includes('6 * 9'));
    expect('read_file', results.read_file === '2\tprint("answer " + n);\n3\t');
    if (final?.reason !== 'end' || final.text !== 'All done.') throw new Error(`done: ${JSON.stringify(final)}`);
    if (agent.todos[0]?.text !== 'build') throw new Error('todos not kept');
    return `9 tools ran in the box; ${types.filter((t) => t === 'tool_call').length} calls, final "${final.text}"`;
  }),
);

await check('teardown removes the frame and fails later calls', () =>
  run(async () => {
    const frames = document.querySelectorAll('iframe').length;
    box.teardown();
    if (document.querySelectorAll('iframe').length !== frames - 1) throw new Error('frame still there');
    try {
      await box.exec('echo');
      throw new Error('call after teardown succeeded');
    } catch (err) {
      if (!(err instanceof BoxError)) throw err;
      return err.message;
    }
  }),
);

await check('boot fails clearly when the runtime is unreachable', () =>
  run(async () => {
    try {
      await BrowserBox.boot({ runtimeUrl: 'http://127.0.0.1:9/', timeoutMs: 1500 });
      throw new Error('boot succeeded');
    } catch (err) {
      if (!(err instanceof BoxError)) throw err;
      return err.message;
    }
  }),
);

if (errors.length) {
  failures++;
  console.log(`FAIL page errors: ${errors.join(' | ')}`);
}
await browser.close();
host.close();
runtime.kill();
console.log(failures ? `\n${failures} failure(s)` : '\nSDK end-to-end test passed');
process.exit(failures ? 1 : 0);
