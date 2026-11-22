// End-to-end test of the SDK (@jeevanand/browserbox): an ordinary page on one
// origin boots the runtime from another, then uses the filesystem, the shell,
// streaming processes, the agent (against a mock model server) and ui().
//
// Usage: npm run build && npm run build:sdk && node scripts/sdk-test.mjs
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { preview } from 'vite';

const { chromium } = createRequire(import.meta.url)('playwright');
const RUNTIME = 'http://127.0.0.1:4561';
const APP = 'http://localhost:4562';

const runtime = await preview({ preview: { port: 4561, host: '127.0.0.1', strictPort: true }, logLevel: 'silent' });

// A mock OpenAI-compatible model: writes a file with a tool, then answers.
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
const llm = createServer((req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end('{"data":[{"id":"mock"}]}');
    const last = JSON.parse(b).messages.at(-1);
    const chunks =
      last.role === 'tool'
        ? [{ choices: [{ delta: { content: 'Wrote greeting.txt.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
        : [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'greeting.txt', content: 'hello from the agent\n' }) } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).end(sse(chunks));
  });
}).listen(4563);

// The embedding app: no special headers, just the SDK file.
const sdk = await readFile('packages/sdk/dist/index.js');
const app = createServer((req, res) => {
  if (req.url === '/sdk.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(sdk);
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>app</title><div id="ui" style="height:400px"></div>');
}).listen(4562);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(APP);
let failed = 0;
const check = async (name, fn) => {
  try {
    console.log(`ok   ${name} → ${await fn()}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message.split('\n')[0]}`);
  }
};
const run = (body) => page.evaluate(`(async () => { ${body} })()`);

await check('boot from another origin, with no COOP/COEP on the app', () =>
  run(`
    const { BrowserBox } = await import('/sdk.js');
    const t = performance.now();
    window.box = await BrowserBox.boot({ runtimeUrl: '${RUNTIME}/embed/' });
    if (window.box.info.protocol !== 1) throw new Error('protocol ' + window.box.info.protocol);
    return 'runtime ' + box.info.version + ', ' + box.info.storage + ', home ' + box.info.home + ', in ' + Math.round(performance.now() - t) + ' ms; app isolated: ' + crossOriginIsolated;
  `),
);

await check('fs: write, read (text and bytes), mount a tree, readdir, rm', () =>
  run(`
    await box.fs.writeFile('a/b/c.txt', 'deep');
    if (await box.fs.readFile('a/b/c.txt', 'utf8') !== 'deep') throw new Error('text');
    const bytes = await box.fs.readFile('a/b/c.txt');
    if (!(bytes instanceof Uint8Array) || bytes.length !== 4) throw new Error('bytes');
    const n = await box.mount({ 'index.html': { file: { contents: '<h1>hi</h1>' } }, src: { directory: { 'main.js': { file: { contents: 'console.log(1)' } } } } }, { mountPoint: 'site' });
    const names = (await box.fs.readdir('site')).map((s) => s.name).sort().join(',');
    await box.fs.rm('a', { recursive: true });
    if (await box.fs.exists('a')) throw new Error('rm');
    let code = '';
    try { await box.fs.readFile('missing.txt', 'utf8'); } catch (e) { code = e.code; }
    return n + ' files mounted (' + names + '); missing file → ' + code;
  `),
);

await check('exec: a pipeline in the shell', () =>
  run(`
    const r = await box.exec('cat site/index.html | wc -c && echo done-42', { cwd: '.' });
    if (r.exitCode !== 0 || !r.stdout.includes('done-42')) throw new Error(JSON.stringify(r));
    const bad = await box.exec('cat nope.txt');
    return JSON.stringify(r.stdout.trim().split('\\n')) + '; failing command exits ' + bad.exitCode + ' with stderr';
  `),
);

await check('spawn: output streams, exit code, kill', () =>
  run(`
    const p = await box.spawn('echo', ['one', 'two words']);
    let out = '';
    await p.output.pipeTo(new WritableStream({ write: (s) => void (out += s) }));
    const code = await p.exit;
    if (out.trim() !== 'one two words' || code !== 0) throw new Error(JSON.stringify({ out, code }));
    const s = await box.spawn('sleep 30');
    setTimeout(() => s.kill(), 300);
    const killed = await s.exit;
    return 'streamed "' + out.trim() + '", exit ' + code + '; sleep killed with ' + killed;
  `),
);

await check('agent: configure a model, it uses its tools on the same files, events stream', () =>
  run(`
    await box.agent.configure({ provider: 'local', baseUrl: 'http://127.0.0.1:4563/v1', model: 'mock' });
    const chat = await box.agent.create();
    const seen = [];
    chat.on((e) => seen.push(e.type));
    let asked = 0;
    const reply = await chat.send('write a greeting');
    const file = await box.fs.readFile('greeting.txt', 'utf8');
    if (file !== 'hello from the agent\\n') throw new Error('file: ' + file);
    const msgs = await chat.messages();
    chat.dispose();
    return 'reply "' + reply + '"; events ' + [...new Set(seen)].join(' ') + '; ' + msgs.length + ' messages';
  `),
);

await check('ui(): the docs (or the agent) shown in the app, same runtime', async () => {
  await run(`box.ui(document.getElementById('ui'), 'docs')`);
  const frame = await (await page.waitForSelector('#ui iframe')).contentFrame();
  await frame.waitForSelector('.dc-link');
  return `${await frame.locator('.dc-link').count()} topics in the embedded docs`;
});

await check('teardown: calls fail clearly afterwards', () =>
  run(`
    box.teardown();
    try { await box.fs.exists('x'); return 'no error'; } catch (e) { return e.message + (document.querySelector('iframe[title="BrowserBox runtime"]') ? ' (frame left behind!)' : ', frame removed'); }
  `),
);

if (errors.length) {
  failed++;
  console.log('page errors:\n  ' + errors.join('\n  '));
}
await browser.close();
await runtime.close();
app.close();
llm.close();
process.exit(failed ? 1 : 0);
