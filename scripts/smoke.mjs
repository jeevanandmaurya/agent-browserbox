// Boots the built system in headless Chromium and exercises it end to end:
// a headless kernel, the agent in its own window, the desktop GUI on demand.
// Usage: npm run build && npm run smoke
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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
// ---- First run: a fresh profile sees the setup before the chat ---------------
await check('first run: setup shows; completing it lands in the chat', async () => {
  await agent.waitForSelector('.su', { timeout: 20000 });
  if (await agent.locator('.composer').isVisible()) throw new Error('the chat is visible behind the setup');
  const next = () => agent.locator('.su-nav .btn.primary').click();
  await agent.locator('.su-choice', { hasText: 'Casual' }).click();
  await next();
  await agent.waitForSelector('.su-model[data-app="settings"] .st-section', { timeout: 10000 }); // the Settings app's Model section, embedded
  await next();
  await agent.locator('.su-choice', { hasText: 'Ask me first' }).click();
  await next();
  if (!(await agent.locator('.pk-item', { hasText: 'Python' }).locator('input').isChecked())) throw new Error('python not preselected');
  if (!(await agent.locator('.pk-item', { hasText: 'Git' }).locator('input').isDisabled())) throw new Error('an unavailable pack is selectable');
  await agent.locator('.su-nav .btn.primary', { hasText: 'Finish' }).click();
  await ready(agent);
  await agent.waitForSelector('.composer', { state: 'visible' });
  return agent.evaluate(() => JSON.stringify({ done: bbx.settings.get('setup.done', false), profile: bbx.settings.get('ui.profile', ''), packs: bbx.settings.get('setup.packs', []), perms: bbx.perms.mode }));
});
await check('setup does not reappear on reload; "Use defaults" also lands in the chat', async () => {
  await agent.reload();
  await ready(agent);
  if (await agent.locator('.su').count()) throw new Error('setup shown again after finishing');
  await agent.evaluate(() => bbx.settings.set('setup.done', false)); // Settings → Tools → Run setup again
  await agent.waitForSelector('.su', { timeout: 5000 });
  await agent.locator('.su-skip').click();
  await agent.waitForSelector('.composer', { state: 'visible' });
  await agent.reload();
  await ready(agent);
  if (await agent.locator('.su').count()) throw new Error('setup shown again after "Use defaults"');
  return 'skipped with defaults, stays done';
});
await check('root redirects to the agent window; kernel boots headless', async () => {
  await ready(agent);
  if (!agent.url().endsWith('/agent/')) throw new Error(agent.url());
  if (await agent.locator('.desk-area, .win').count()) throw new Error('a desktop was rendered in the agent window');
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
await check('sandbox: python (pyodide)', async () => {
  const out = await term(`python -c "import sys, json; open('py.json','w').write(json.dumps({'v': sum(range(10))})); print('py', sys.version_info.major)" && cat py.json && echo py-done`, 'py-done', 90000);
  if (!out.includes('py 3') || !out.includes('{"v": 45}')) throw new Error(out.slice(-300));
});
await check('webgpu compute inside the kernel worker', async () => {
  if (!(await desk.evaluate(() => 'gpu' in navigator && navigator.gpu.requestAdapter().then((a) => !!a)))) return 'skipped (no adapter in this browser)';
  await desk.evaluate(() => bbx.fs.writeFile('/tmp/sq.wgsl', '@group(0) @binding(0) var<storage, read> input: array<f32>;\n@group(0) @binding(1) var<storage, read_write> output: array<f32>;\n@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { if (id.x < arrayLength(&output)) { output[id.x] = input[id.x] * input[id.x]; } }'));
  const out = await term('echo "[1,2,3,4]" | gpu /tmp/sq.wgsl 4; echo gpu=$?', 'gpu=');
  if (!out.includes('[1,4,9,16]')) throw new Error(out.slice(-300));
});

// ---- The agent, running in the kernel, driven from its own window -------------
await check('agent: tool loop, approvals across windows, validation', async () => {
  const popupsBefore = popups;
  await agent.evaluate(() => bbx.settings.set('agent.config', { provider: 'openai', openaiBaseUrl: 'http://localhost:11434/v1', openaiModel: 'mock' }));
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
  // The composer's model picker leads to the same place.
  await agent.locator('.mp-btn').click();
  await agent.locator('.mp-menu .pop-item', { hasText: 'Model settings' }).click();
  await agent.waitForSelector('.sm-dialog .sn-tab[aria-selected="true"]:text("Model")', { timeout: 10000 });
  await agent.keyboard.press('Escape');
  if (popups !== before) throw new Error('a new window opened');
  return 'modal, Model section, Esc closes';
});
await check('agent window: Files and Terminal open in the workbench; a command runs', async () => {
  const before = popups;
  await agent.locator('.bb-files').click();
  await agent.waitForSelector('.wb-pane[data-app="files"]:not([hidden]) .files-table', { timeout: 10000 });
  await agent.locator('.bb-term').click();
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
