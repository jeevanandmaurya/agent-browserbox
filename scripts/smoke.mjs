// Boots the built OS in headless Chromium and exercises the main paths.
// Usage: npm run build && npm run smoke
import { createRequire } from 'node:module';
// Resolve Playwright from the project or a global install (NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');
import { preview } from 'vite';
import { readFileSync } from 'node:fs';

const server = await preview({ preview: { port: 4517, strictPort: true }, logLevel: 'silent' });
const url = 'http://localhost:4517/';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
let failed = 0;
const check = async (name, fn) => {
  try {
    const out = await fn();
    console.log(`ok   ${name}${out === undefined ? '' : ' → ' + (typeof out === 'string' ? out : JSON.stringify(out))}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${JSON.stringify(err.message.slice(0, 400))}`);
  }
};

await page.goto(url);
await check('boot marks', async () => {
  await page.waitForFunction(() => globalThis.bbx?.bootMarks.some((m) => m.name === 'ready'));
  return page.evaluate(() => bbx.bootMarks.map((m) => `${m.name}@${m.at}ms`).join(' '));
});
await check('root filesystem', () => page.evaluate(async () => `${bbx.rootKind}: ${(await bbx.fs.readdir('/')).map((s) => s.name).join(',')}`));
await check('fs roundtrip', () =>
  page.evaluate(async () => {
    await bbx.fs.writeFile('/tmp/a/b.txt', 'hello');
    await bbx.fs.cp('/tmp/a', '/home/user/copy');
    const t = await bbx.fs.readText('/home/user/copy/b.txt');
    await bbx.fs.rm('/home/user/copy', { recursive: true });
    if (t !== 'hello') throw new Error(t);
    return (await bbx.fs.glob('/tmp/**/*.txt')).join(',');
  }),
);
await check('kcore wasm', () => page.evaluate(async () => (await bbx.kcore.load(), `${bbx.kcore.loaded} ${bbx.kcore.hash(new TextEncoder().encode('abc'))}`)));


// ---- Terminal & shell -------------------------------------------------------
const openApp = async (id) => {
  await page.evaluate((id) => bbx.openApp(id), id);
  await page.waitForSelector(`.win-body[data-app="${id}"]`);
};
const term = async (cmd, waitFor, timeout = 20000) => {
  const input = page.locator('.term-input').last();
  await input.fill(cmd);
  await input.press('Enter');
  if (waitFor) await page.waitForFunction((t) => document.querySelector('.term-out')?.textContent.includes(t), waitFor, { timeout });
  else await page.waitForFunction(() => !document.querySelector('.term-line.busy'), null, { timeout });
  await page.waitForFunction(() => !document.querySelector('.term-line.busy'), null, { timeout });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // output is flushed per frame
  return page.evaluate(() => document.querySelector('.term-out').textContent);
};
await openApp('terminal');
await check('shell: pipes, redirects, globs', async () => {
  const out = await term('cd /tmp && mkdir -p t && echo b > t/x.txt && echo a >> t/x.txt && echo b >> t/x.txt && sort t/*.txt | uniq -c | wc -l && echo ok-$?', 'ok-0');
  if (!/\n2\nok-0/.test(out)) throw new Error(out.slice(-200));
});
await check('shell: errors and exit codes', async () => {
  const out = await term('nosuch || cat /nope; echo code=$?', 'code=');
  if (!out.includes('command not found') || !out.includes('ENOENT') || !out.includes('code=1')) throw new Error(out.slice(-300));
});
await check('sandbox: js with fs bridge', async () => {
  const out = await term(`js -e "print(6*7); await fs.writeFile('made.txt','from sandbox'); return typeof indexedDB + '/' + (await fs.readText('made.txt'))" && cat made.txt && echo js-done`, 'js-done');
  if (!out.includes('42') || !out.includes('from sandbox')) throw new Error(out.slice(-300));
  return out.match(/(\w+)\/from sandbox/)?.[0];
});
await check('sandbox: cannot reach host storage or network', async () => {
  const out = await term(`js -e "const r = []; try { await navigator.storage.getDirectory(); r.push('opfs-open') } catch { r.push('opfs-blocked') } try { await fetch('https://example.com'); r.push('net-open') } catch { r.push('net-blocked') } return r.join(',')" ; echo iso-done`, 'iso-done');
  if (!out.includes('opfs-blocked,net-blocked')) throw new Error(out.slice(-300));
});
await check('sandbox: infinite loop is killed', async () => {
  await page.evaluate(() => (globalThis.__t = performance.now()));
  const input = page.locator('.term-input').last();
  await input.fill('js -e "while(true){}"');
  await input.press('Enter');
  await page.waitForTimeout(600);
  await input.press('Control+c');
  await page.waitForFunction(() => !document.querySelector('.term-line.busy'), null, { timeout: 5000 });
  return 'aborted with ^C';
});
await check('sandbox: wasi program', async () => {
  const bytes = [...readFileSync('tests/fixtures/hello.wasm')];
  await page.evaluate((b) => bbx.fs.writeFile('/tmp/hello.wasm', new Uint8Array(b)), bytes);
  const out = await term('echo piped | wasm /tmp/hello.wasm one two; echo wasm=$?', 'wasm=');
  if (!out.includes('hello from wasi; args=["one", "two"]; stdin="piped"') || !out.includes('wasm=3')) throw new Error(out.slice(-300));
});
await check('sandbox: python (pyodide)', async () => {
  const out = await term(`python -c "import sys, json; open('py.json','w').write(json.dumps({'v': sum(range(10))})); print('py', sys.version_info.major)" && cat py.json && echo py-done`, 'py-done', 90000);
  if (!out.includes('py 3') || !out.includes('{"v": 45}')) throw new Error(out.slice(-300));
});
await check('webgpu compute', async () => {
  if (!(await page.evaluate(() => 'gpu' in navigator && navigator.gpu.requestAdapter().then((a) => !!a)))) return 'skipped (no adapter in this browser)';
  await page.evaluate(() => bbx.fs.writeFile('/tmp/sq.wgsl', '@group(0) @binding(0) var<storage, read> input: array<f32>;\n@group(0) @binding(1) var<storage, read_write> output: array<f32>;\n@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { if (id.x < arrayLength(&output)) { output[id.x] = input[id.x] * input[id.x]; } }'));
  const out = await term('echo "[1,2,3,4]" | gpu /tmp/sq.wgsl 4; echo gpu=$?', 'gpu=');
  if (!out.includes('[1,4,9,16]')) throw new Error(out.slice(-300));
});

// ---- Agent against a scripted OpenAI-compatible server -----------------------
const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
let turn = 0;
const requests = [];
await page.route('http://localhost:11434/v1/chat/completions', async (route) => {
  requests.push(route.request().postDataJSON());
  const call = (i, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: i, id: `c${turn}_${i}`, function: { name, arguments: JSON.stringify(args) } }] } }] });
  const script = [
    [{ choices: [{ delta: { content: 'Working on it. ' } }] }, call(0, 'write_file', { path: 'report.md', content: '# Report\nhello' }), call(1, 'shell', { command: 'wc -l report.md && ls' }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
    [call(0, 'run_js', { code: 'return (await fs.readText("report.md")).toUpperCase()' }), call(1, 'read_file', { path: '/home/user/Welcome.md', limit: 2 }), call(2, 'nope', {}), call(3, 'edit_file', { path: 'report.md' }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
    [{ choices: [{ delta: { content: 'All **done**: see `report.md`.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }],
  ];
  await route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: sse(script[Math.min(turn++, script.length - 1)]) });
});
await check('agent: tool loop, approvals, validation', async () => {
  await page.evaluate(() => bbx.settings.set('agent.config', { provider: 'openai', openaiBaseUrl: 'http://localhost:11434/v1', openaiModel: 'mock' }));
  await openApp('agent');
  await page.locator('.ag-input').last().fill('make a report');
  await page.locator('.ag-input').last().press('Enter');
  // write_file in the agent workspace is free; shell needs approval.
  await page.locator('.modal.perm .btn.primary').click({ timeout: 10000 });
  await page.locator('.modal.perm .btn', { hasText: 'Always allow' }).click({ timeout: 10000 }); // run_js → exec, granted for good
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-text strong')].some((e) => e.textContent === 'done'), null, { timeout: 20000 });
  const results = requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const expect = [/Wrote 14 characters/, /^1\n.*report\.md/s, /# REPORT\nHELLO/, /Welcome to BrowserBox/, /ERROR: Unknown tool "nope"/, /ERROR: Invalid input for edit_file: missing required property "old_string"/];
  expect.forEach((re, i) => {
    if (!re.test(results[i] ?? '')) throw new Error(`tool result ${i} was ${JSON.stringify(results[i])}`);
  });
  await page.waitForFunction(() => bbx.fs.readdir('/home/agent/.sessions').then((l) => l.length === 1, () => false), null, { timeout: 5000 }).catch(() => {
    throw new Error('session was not saved');
  });
  return `${results.length} tool results, session saved, grants=${await page.evaluate(() => bbx.perms.grants().join(','))}`;
});
await check('agent: cli in the terminal', async () => {
  turn = 2;
  await page.locator('.task', { hasText: 'Terminal' }).click();
  const out = await term('agent "say done"', 'All **done**');
  if (!out.includes('report.md')) throw new Error(out.slice(-200));
});
await check('processes are cleaned up', () =>
  page.evaluate(() => {
    const left = bbx.procs.list().filter((p) => p.kind === 'sandbox' && p.name !== 'python');
    if (left.length) throw new Error('leaked: ' + left.map((p) => p.name).join(','));
    return bbx.procs.list().map((p) => `${p.name}[${p.kind}]`).join(' ');
  }),
);

await check('every app opens', async () => {
  const ids = await page.evaluate(() => [...document.querySelectorAll('.desk-icon')].length);
  for (let i = 0; i < ids; i++) await page.locator('.desk-icon').nth(i).dblclick({ force: true });
  await page.evaluate(() => (bbx.openApp('preview', { html: '<h1 id=x>hi</h1>', title: 't' }), bbx.openApp('editor', { path: '/home/user/Welcome.md' }), bbx.openApp('settings', { section: 'model' })));
  await page.waitForFunction((n) => new Set([...document.querySelectorAll('.win-body[data-app]')].map((e) => e.dataset.app)).size >= n, ids + 1, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const bad = await page.evaluate(() => [...document.querySelectorAll('.app-error')].map((e) => e.textContent.slice(0, 200)));
  if (bad.length) throw new Error(bad.join(' | '));
  return `${ids + 1} apps`;
});
if (process.env.SHOTS) {
  for (const id of ['agent', 'terminal', 'files', 'editor', 'taskmgr', 'browser', 'gpulab', 'sysinfo', 'settings']) {
    const win = page.locator(`.win:has(.win-body[data-app="${id}"])`).last();
    await win.dispatchEvent('pointerdown'); // raise it
    await win.screenshot({ path: `${process.env.SHOTS}/${id}.png` });
  }
}
await page.screenshot({ path: process.env.SHOT ?? 'smoke.png' });
if (errors.length) {
  failed++;
  console.log('page errors:\n  ' + errors.join('\n  '));
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
