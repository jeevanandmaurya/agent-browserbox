// Boots the built system in headless Chromium and exercises it end to end:
// a headless kernel, the agent in its own window, the desktop GUI on demand.
// Usage: npm run build && npm run smoke
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { preview } from 'vite';
// Resolve Playwright from the project or a global install (NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');

const server = await preview({ preview: { port: 4517, strictPort: true }, logLevel: 'silent' });
const base = 'http://localhost:4517/';

// A scripted OpenAI-compatible model server. The kernel worker calls it for real.
let turn = 0;
const requests = [];
const call = (i, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: i, id: `c${turn}_${i}`, function: { name, arguments: JSON.stringify(args) } }] } }] });
const SCRIPT = [
  () => [{ choices: [{ delta: { content: 'Working on it. ' } }] }, call(0, 'write_file', { path: 'report.md', content: '# Report\nhello' }), call(1, 'shell', { command: 'wc -l report.md && ls' }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
  () => [call(0, 'run_js', { code: 'return (await fs.readText("report.md")).toUpperCase()' }), call(1, 'read_file', { path: '/home/user/Welcome.md', limit: 2 }), call(2, 'nope', {}), call(3, 'edit_file', { path: 'report.md' }), call(4, 'show_html', { html: '<h1>chart</h1>', title: 'Chart' }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
  () => [{ choices: [{ delta: { content: 'All **done**: see `report.md`.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }],
];
const llm = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock' }] }));
    requests.push(JSON.parse(body));
    const chunks = SCRIPT[Math.min(turn++, SCRIPT.length - 1)]();
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
}).listen(11434);

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`));
  return page;
};
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
let popups = 0;
context.on('page', () => popups++);
const ready = (page) => page.waitForFunction(() => globalThis.bbx?.bootMarks.some((m) => m.name === 'ready'), null, { timeout: 20000 });

// ---- The agent window: no desktop, just the kernel and one page --------------
let agent = watch(await context.newPage(), 'agent');
await agent.goto(base);
// ---- First boot: kernel log, then `setup` asks its questions in the console ----
/** Answers boot-console prompts in order ('' accepts the default) until the GUI appears. */
async function firstBoot(page, answers) {
  const prompts = [];
  for (const answer of answers) {
    await page.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 20000 });
    prompts.push(await page.locator('.boot-console .term-prompt').textContent());
    await page.locator('.boot-console .term-input').fill(answer);
    await page.locator('.boot-console .term-input').press('Enter');
  }
  return prompts;
}
// ---- Startup stays lean: what loads before you can type ---------------------
await check('startup bundles stay within budget, with nothing loaded early that is not needed', async () => {
  const assets = readdirSync('dist/assets');
  // All the files with that name: Rollup may split an entry into a stub and its body.
  const read = (prefix) => assets.filter((f) => f.startsWith(prefix) && f.endsWith('.js')).map((f) => readFileSync(`dist/assets/${f}`, 'utf8')).join('\n');
  const kernel = read('main-');
  const agent = read('agent-');
  const kb = (t) => gzipSync(t).length / 1024;
  const problems = [];
  // Budgets, compressed (they were 54 and 20 KB when set).
  if (kb(kernel) > 60) problems.push(`kernel worker ${kb(kernel).toFixed(1)} KB > 60 KB`);
  if (kb(agent) > 24) problems.push(`agent window ${kb(agent).toFixed(1)} KB > 24 KB`);
  // Kernel-only code in the window, or on-demand code in the kernel's startup file.
  if (agent.includes('Your context window is nearly full')) problems.push('the agent loop is bundled into the agent window');
  if (kernel.includes('BrowserBox dev runtime')) problems.push('the dev server loads at kernel startup');
  if (problems.length) throw new Error(problems.join('; '));
  return `kernel ${kb(kernel).toFixed(1)} KB, agent window ${kb(agent).toFixed(1)} KB (gzip)`;
});

await check('first boot: kernel log, then setup in the console, then the agent window', async () => {
  await agent.waitForSelector('.boot-console', { timeout: 20000 });
  await agent.waitForFunction(() => /vfs: mounted (opfs|memfs) on \//.test(document.querySelector('.boot-console .term-out')?.textContent ?? '') && /first boot/.test(document.querySelector('.boot-console .term-out').textContent), null, { timeout: 20000 });
  // a name, then skip the API key and the local server
  const prompts = await firstBoot(agent, ['Ada', '', '']);
  if (!/name/i.test(prompts[0] ?? '')) throw new Error(`first prompt: ${prompts[0]}`);
  await ready(agent);
  await agent.waitForSelector('.composer', { state: 'visible' });
  const log = await agent.evaluate(() => bbx.kernelLog.map((l) => `${l.src}: ${l.msg}`).join(' | '));
  if (!/kernel: ready/.test(log)) throw new Error(log);
  if ((await agent.evaluate(() => bbx.settings.get('user.name', ''))) !== 'Ada') throw new Error('the name was not saved');
  return `${prompts.length} prompts answered; ${agent.evaluate ? (await agent.evaluate(() => JSON.stringify({ name: bbx.settings.get('user.name', ''), done: bbx.settings.get('setup.done', false), installed: bbx.settings.get('pkg.installed', []), perms: bbx.perms.mode }))) : ''}`;
});
await check('later boots show the log but do not ask again', async () => {
  await agent.reload();
  await ready(agent);
  if (await agent.locator('.boot-console .term-line:not(.busy)').count()) throw new Error('setup asked again');
  return 'straight to the agent window';
});
await check('root redirects to the agent window; kernel boots headless', async () => {
  await ready(agent);
  if (!agent.url().endsWith('/agent/')) throw new Error(agent.url());
  if (await agent.locator('.desk-area, .win').count()) throw new Error('a desktop was rendered in the agent window');
  if (await agent.locator('.boot').count()) throw new Error('the boot placeholder was left on the page');
  const top = await agent.locator('.bb').evaluate((el) => el.getBoundingClientRect().top);
  if (top !== 0) throw new Error(`the app is not at the top of the window (top=${top})`);
  return agent.evaluate(() => `${bbx.bootMarks.map((m) => `${m.name}@${m.at}`).join(' ')} shared=${bbx.shared} root=${bbx.rootKind}`);
});
await check('kernel processes exist without any GUI', () =>
  agent.evaluate(() => {
    const names = bbx.procs.list().map((p) => `${p.name}[${p.kind}]`);
    if (!names.includes('kernel[service]') || !names.includes('agent[agent]')) throw new Error(names.join(' '));
    if (names.some((n) => n.startsWith('desktop'))) throw new Error('desktop is running');
    return names.join(' ');
  }),
);
await check('filesystem over RPC', () =>
  agent.evaluate(async () => {
    await bbx.fs.writeFile('/tmp/a/b.txt', 'hello');
    await bbx.fs.cp('/tmp/a', '/home/user/copy');
    const t = await bbx.fs.readText('/home/user/copy/b.txt');
    await bbx.fs.rm('/home/user/copy', { recursive: true });
    if (t !== 'hello') throw new Error(t);
    return (await bbx.fs.glob('/tmp/**/*.txt')).join(',');
  }),
);
await check('windows cannot read secrets back', () =>
  agent.evaluate(async () => {
    await bbx.secrets.set('probe', 'x');
    const has = await bbx.secrets.has('probe');
    const leak = await bbx.call('secrets.get', 'probe').then(() => 'LEAK', (e) => e.message);
    await bbx.secrets.delete('probe');
    if (!has || leak === 'LEAK') throw new Error(`has=${has} ${leak}`);
    return leak;
  }),
);

// ---- GUI on demand: the desktop is a second window onto the same kernel -------
let desk;
await check('desktop opens explicitly in its own window', async () => {
  desk = watch(await context.newPage(), 'desktop');
  await desk.goto(base + 'os/');
  await ready(desk);
  await desk.locator('.desk-icon', { hasText: 'Files' }).dblclick();
  await desk.waitForSelector('.win-body[data-app="files"]', { timeout: 15000 });
  if (await agent.locator('.wb-pane').count()) throw new Error('the desktop’s own app launch leaked into the agent window');
  return desk.url().replace(base, '/');
});
await check('both windows share one kernel', async () => {
  await desk.evaluate(() => (bbx.fs.writeFile('/tmp/shared.txt', 'from desktop'), bbx.settings.set('probe.key', 42)));
  await agent.waitForFunction(() => bbx.settings.get('probe.key', 0) === 42);
  const seen = await agent.evaluate(async () => `${await bbx.fs.readText('/tmp/shared.txt')} | ${bbx.procs.list().filter((p) => ['desktop', 'Files', 'Agent window'].includes(p.name)).map((p) => p.name).join(',')}`);
  if (seen !== 'from desktop | Agent window,desktop,Files') throw new Error(seen);
  return seen;
});

// ---- Terminal → kernel shell → sandbox host ------------------------------------
const term = async (cmd, waitFor, timeout = 20000) => {
  const input = desk.locator('.term-input').last();
  await input.fill(cmd);
  await input.press('Enter');
  if (waitFor) await desk.waitForFunction((t) => document.querySelector('.term-out')?.textContent.includes(t), waitFor, { timeout });
  await desk.waitForFunction(() => !document.querySelector('.term-line.busy'), null, { timeout });
  await desk.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // output is flushed per frame
  return desk.evaluate(() => document.querySelector('.term-out').textContent);
};
await desk.evaluate(() => bbx.openApp('terminal'));
await desk.waitForSelector('.term-input');
await check('shell runs in the kernel: pipes, redirects, globs, $?', async () => {
  const out = await term('cd /tmp && mkdir -p t && echo b > t/x.txt && echo a >> t/x.txt && echo b >> t/x.txt && sort t/*.txt | uniq -c | wc -l && nosuch || echo code=$?', 'code=127');
  if (!/\n2\n/.test(out) || !out.includes('command not found')) throw new Error(out.slice(-300));
  return desk.evaluate(() => bbx.procs.list().filter((p) => p.kind === 'shell').map((p) => `${p.name} pid ${p.pid}`).join(','));
});
await check('sandbox: js with fs bridge', async () => {
  const out = await term(`js -e "print(6*7); await fs.writeFile('made.txt','from sandbox'); return await fs.readText('made.txt')" && cat made.txt && echo js-done`, 'js-done');
  if (!out.includes('42') || !out.includes('from sandbox')) throw new Error(out.slice(-300));
});
await check('sandbox: cannot reach host storage or network', async () => {
  const out = await term(`js -e "const r = []; try { await navigator.storage.getDirectory(); r.push('opfs-open') } catch { r.push('opfs-blocked') } try { await fetch('https://example.com'); r.push('net-open') } catch { r.push('net-blocked') } return r.join(',')" ; echo iso-done`, 'iso-done');
  if (!out.includes('opfs-blocked,net-blocked')) throw new Error(out.slice(-300));
});
await check('sandbox: infinite loop is killed with ^C', async () => {
  const input = desk.locator('.term-input').last();
  await input.fill('js -e "while(true){}"');
  await input.press('Enter');
  await desk.waitForTimeout(800);
  await input.press('Control+c');
  await desk.waitForFunction(() => !document.querySelector('.term-line.busy'), null, { timeout: 5000 });
});
await check('sandbox: wasi program', async () => {
  const bytes = [...readFileSync('tests/fixtures/hello.wasm')];
  await desk.evaluate((b) => bbx.fs.writeFile('/tmp/hello.wasm', new Uint8Array(b)), bytes);
  const out = await term('echo piped | wasm /tmp/hello.wasm one two; echo wasm=$?', 'wasm=3');
  if (!out.includes('hello from wasi; args=["one", "two"]; stdin="piped"')) throw new Error(out.slice(-300));
});
await check('package: python installs with progress and runs (pyodide)', async () => {
  const out = await term(`pkg install python && python -c "import sys, json; open('py.json','w').write(json.dumps({'v': sum(range(10))})); print('py', sys.version_info.major)" && cat py.json && echo py-done`, 'py-done', 90000);
  if (!out.includes('py 3') || !out.includes('{"v": 45}')) throw new Error(out.slice(-300));
});
await check('webgpu compute inside the kernel worker', async () => {
  if (!(await desk.evaluate(() => 'gpu' in navigator && navigator.gpu.requestAdapter().then((a) => !!a)))) return 'skipped (no adapter in this browser)';
  await desk.evaluate(() => bbx.fs.writeFile('/tmp/sq.wgsl', '@group(0) @binding(0) var<storage, read> input: array<f32>;\n@group(0) @binding(1) var<storage, read_write> output: array<f32>;\n@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { if (id.x < arrayLength(&output)) { output[id.x] = input[id.x] * input[id.x]; } }'));
  const out = await term('echo "[1,2,3,4]" | gpu /tmp/sq.wgsl 4; echo gpu=$?', 'gpu=');
  if (!out.includes('[1,4,9,16]')) throw new Error(out.slice(-300));
});

await check('tool packs: pkg, git, sqlite3, zip', async () => {
  const gated = await term('pkg remove zip; zip /tmp/x.zip /tmp; echo gated=$?', 'gated=');
  if (!gated.includes('provided by the zip package, which is not installed')) throw new Error(gated.slice(-300));
  const out = await term('pkg install git sqlite zip && mkdir -p /tmp/repo && cd /tmp/repo && git init && echo one > a.txt && git add . && git commit -m first && echo two >> a.txt && git status && git diff && git commit -a -m second && git log --oneline && sqlite3 t.db "create table t(x); insert into t values (41),(1); select sum(x) from t" && sqlite3 t.db .tables && zip -r /tmp/r.zip a.txt && unzip -l /tmp/r.zip && cd /tmp && echo packs-done', 'packs-done', 60000);
  for (const want of ['] first', '] second', 'M  a.txt', '+two', '\n42\n', '\nt\n', '1 files → /tmp/r.zip']) if (!out.includes(want)) throw new Error(`missing ${JSON.stringify(want)} in ${out.slice(-700)}`);
  return out.split('\n').filter((l) => /^[0-9a-f]{7} /.test(l)).join(' | ');
});

// ---- The agent, running in the kernel, driven from its own window -------------
await check('agent: tool loop, approvals across windows, validation', async () => {
  const popupsBefore = popups;
  await agent.evaluate(() => bbx.settings.set('agent.config', { provider: 'local', localBaseUrl: 'http://localhost:11434/v1', localModel: 'mock' }));
  await agent.bringToFront();
  await agent.locator('.ag-input').fill('make a report');
  await agent.locator('.ag-input').press('Enter');
  // write_file in the agent workspace is free; shell needs approval. The prompt shows in every window.
  // In the agent window the request is an inline card in the conversation; other windows show a dialog.
  await desk.waitForSelector('.modal.perm');
  await agent.locator('.ag-approval:not(.settled) .btn.primary').click({ timeout: 10000 });
  await agent.locator('.ag-approval:not(.settled) .btn', { hasText: 'Always allow' }).click({ timeout: 10000 }); // run_js → exec, granted for good
  await agent.waitForFunction(() => [...document.querySelectorAll('.ag-text strong')].some((e) => e.textContent === 'done'), null, { timeout: 20000 });
  const results = requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const expect = [/Wrote 14 characters/, /^1\n.*report\.md/s, /# REPORT\nHELLO/, /Welcome to BrowserBox/, /ERROR: Unknown tool "nope"/, /ERROR: Invalid input for edit_file: missing required property "old_string"/, /preview window is open/];
  expect.forEach((re, i) => {
    if (!re.test(results[i] ?? '')) throw new Error(`tool result ${i} was ${JSON.stringify(results[i])}`);
  });
  // show_html appears inside the agent window's workbench, with no new window.
  await agent.waitForSelector('.wb-pane[data-app="preview"]:not([hidden]) iframe', { timeout: 10000 });
  if (popups !== popupsBefore) throw new Error(`${popups - popupsBefore} new window(s) opened`);
  if (await desk.locator('.modal.perm').count()) throw new Error('a prompt answered in the agent window is still showing on the desktop');
  await agent.waitForFunction(() => bbx.fs.readdir('/home/agent/.sessions').then((l) => l.length === 1, () => false), null, { timeout: 5000 });
  return `${results.length} tool results, preview shown in the agent window, session saved by kernel`;
});
await check('agent session survives its window closing', async () => {
  await agent.close();
  await desk.waitForFunction(() => !bbx.procs.list().some((p) => p.name === 'Agent window'), null, { timeout: 10000 });
  const still = await desk.evaluate(() => bbx.procs.list().filter((p) => p.kind === 'agent').length);
  if (still !== 1) throw new Error(`agent processes: ${still}`);
  agent = watch(await context.newPage(), 'agent');
  await agent.goto(base + 'agent/');
  await ready(agent);
  await agent.waitForFunction(() => document.querySelector('.ag-msg.user')?.textContent === 'make a report' && document.querySelectorAll('.ag-tool').length >= 7, null, { timeout: 10000 });
  return 'reattached with full transcript';
});
await check('agent: cli in the terminal', async () => {
  turn = 2;
  const out = await term('agent "say done"', 'All **done**');
  if (!out.includes('report.md')) throw new Error(out.slice(-200));
});
await check('every desktop app opens', async () => {
  const n = await desk.locator('.desk-icon').count();
  await desk.evaluate(() => {
    for (const id of ['files', 'editor', 'taskmgr', 'browser', 'gpulab', 'sysinfo', 'terminal']) bbx.openApp(id);
    bbx.openApp('editor', { path: '/home/user/Welcome.md' });
    bbx.openApp('settings', { section: 'model' });
  });
  await desk.waitForFunction(() => new Set([...document.querySelectorAll('.win-body[data-app]')].map((e) => e.dataset.app)).size >= 9, null, { timeout: 15000 }).catch(async () => {
    throw new Error('only: ' + (await desk.evaluate(() => [...document.querySelectorAll('.win')].map((e) => `${e.getAttribute('aria-label')}=${e.querySelector('.win-body').dataset.app ?? e.querySelector('.win-body').textContent.slice(0, 80)}`).join(' | '))));
  });
  await desk.waitForTimeout(1500);
  const bad = await desk.evaluate(() => [...document.querySelectorAll('.app-error')].map((e) => e.textContent.slice(0, 200)));
  if (bad.length) throw new Error(bad.join(' | '));
  return `${n} icons, 9 apps`;
});
if (process.env.SHOTS) {
  await agent.screenshot({ path: `${process.env.SHOTS}/agent-window.png` });
  await desk.screenshot({ path: `${process.env.SHOTS}/desktop.png` });
  for (const id of ['terminal', 'taskmgr', 'settings']) {
    const win = desk.locator(`.win:has(.win-body[data-app="${id}"])`).last();
    await win.dispatchEvent('pointerdown'); // raise it
    await win.screenshot({ path: `${process.env.SHOTS}/${id}.png` });
  }
}
await check('closing the desktop leaves the kernel and agent running', async () => {
  await desk.close();
  await agent.waitForFunction(() => !bbx.procs.list().some((p) => ['desktop', 'Files', 'Terminal', 'bbsh'].includes(p.name)), null, { timeout: 10000 });
  const out = await agent.evaluate(async () => `${bbx.procs.list().map((p) => `${p.name}[${p.kind}]`).join(' ')} | ${await bbx.fs.readText('/home/agent/report.md')}`);
  if (!out.includes('agent[agent]') || !out.includes('# Report')) throw new Error(out);
  return out.split(' | ')[0];
});

// ---- The agent window is self-contained: settings, files, terminal built in ----
await check('agent window: settings open inside the page on the Model section', async () => {
  const before = popups;
  await agent.bringToFront();
  await agent.locator('.sb-row', { hasText: 'Settings' }).click();
  await agent.waitForSelector('.sm-dialog [data-app="settings"] .sn-tab[aria-selected="true"]', { timeout: 10000 });
  const tab = await agent.locator('.sm-dialog .sn-tab[aria-selected="true"]').textContent();
  if (tab !== 'Model') throw new Error(`section ${tab}`);
  await agent.keyboard.press('Escape');
  await agent.waitForSelector('.sm-overlay', { state: 'detached' });
  // The model name under the title leads to the same place.
  await agent.locator('.cp-model').click();
  await agent.locator('.menu .pop-item', { hasText: 'Model settings' }).click();
  await agent.locator('.sm-dialog .sn-tab[aria-selected="true"]', { hasText: 'Model' }).waitFor({ timeout: 10000 });
  await agent.keyboard.press('Escape');
  if (popups !== before) throw new Error('a new window opened');
  return 'modal, Model section, Esc closes';
});
await check('agent window: Files and Terminal open in the workbench; a command runs', async () => {
  const before = popups;
  await agent.locator('.bb-more').click();
  await agent.locator('.menu .pop-item', { hasText: 'Files' }).click();
  await agent.waitForSelector('.wb-pane[data-app="files"]:not([hidden]) .files-table', { timeout: 10000 });
  await agent.locator('.bb-more').click();
  await agent.locator('.menu .pop-item', { hasText: 'Terminal' }).click();
  const input = agent.locator('.wb-pane[data-app="terminal"] .term-input');
  await input.waitFor({ timeout: 10000 });
  await input.fill('echo ok-$AGENT_HOME-$USER && pwd');
  await input.press('Enter');
  await agent.waitForFunction(() => /ok-\/home\/agent-user/.test(document.querySelector('.wb-pane[data-app="terminal"] .term-out')?.textContent ?? ''), null, { timeout: 15000 });
  const out = await agent.locator('.wb-pane[data-app="terminal"] .term-out').textContent();
  if (popups !== before) throw new Error('a new window opened');
  if (await agent.evaluate(() => bbx.procs.list().some((p) => p.name === 'desktop'))) throw new Error('the desktop started');
  return out.trim().split('\n').slice(-3).join(' | ');
});

if (errors.length) {
  failed++;
  console.log('page errors:\n  ' + errors.join('\n  '));
}
await browser.close();
await server.close();
llm.close();
process.exit(failed ? 1 : 0);
