// End-to-end checks for the agent's extension features, driven against a
// scripted OpenAI-compatible model and a real (local) MCP server:
// tool packs with progress, environment variables, skills, custom agents,
// slash commands, context meter and compaction, connectors.
// Usage: npm run build && node scripts/features.mjs
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preview } from 'vite';
const { chromium } = createRequire(import.meta.url)('playwright');

const server = await preview({ configFile: 'apps/browserbox/vite.config.ts', preview: { port: 4521, strictPort: true }, logLevel: 'silent' });
const base = 'http://localhost:4521/';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'mcp-session-id' };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

// ---- A minimal MCP server (Streamable HTTP, JSON replies) --------------------
const mcpCalls = [];
const mcp = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const msg = JSON.parse((await body(req)) || '{}');
  if (req.headers.authorization !== 'Bearer s3cret') return res.writeHead(401, cors).end();
  if (!('id' in msg)) return res.writeHead(202, cors).end();
  const reply = (result) => res.writeHead(200, { ...cors, 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'weather', version: '1' } });
  if (msg.method === 'tools/list') return reply({ tools: [{ name: 'forecast', description: 'Weather forecast for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] });
  if (msg.method === 'tools/call') {
    mcpCalls.push({ ...msg.params, session: req.headers['mcp-session-id'] });
    return reply({ content: [{ type: 'text', text: `Sunny in ${msg.params.arguments.city}, 21°C` }] });
  }
  res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } }));
}).listen(11437);

// ---- A scripted model that answers according to the request -----------------
const requests = [];
const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
// Reports a plausible token count for the request, as a real server would.
let promptTokens = 0;
const text = (t) => [{ choices: [{ delta: { content: t } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(t.length / 4) } }];
const call = (name, args) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${requests.length}`, function: { name, arguments: JSON.stringify(args) } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
function respond(r) {
  const msgs = r.messages;
  const last = msgs.at(-1);
  const userText = (c) => (Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : (c ?? ''));
  const lastUser = userText(msgs.findLast((m) => m.role === 'user')?.content);
  const system = msgs[0].content;
  if (lastUser.includes('Your context window is nearly full')) return text('SUMMARY: the user asked about skills and weather; all done.');
  if (last.role === 'tool' && last.content.includes('installed python') && r.tools.some((t) => t.function.name === 'run_python')) return call('run_python', { code: 'print(6 * 7)' });
  if (last.role === 'tool' && last.content.startsWith('Serving ')) return call('preview_logs', { wait_ms: 1500, all: true });
  // A file is read before it is changed (the agent refuses to edit blind): read, then write.
  if (lastUser.includes('change the notes') && last.role === 'tool' && /^\s+1\t/.test(last.content)) return call('write_file', { path: 'notes.txt', content: 'first\nSECOND\nthird\n' });
  // The preview tool: open a page, type into it, read it, check it, look at it.
  // (A screenshot comes back as an image in a user message after the tool's result.)
  if (lastUser.startsWith('The images from the tool results') && JSON.stringify(msgs).includes('test the guestbook')) return text(`PREVIEW DONE ${msgs.filter((m) => m.role === 'tool').map((m) => m.content.split('\n')[0]).join(' | ')}`);
  if (lastUser.includes('test the guestbook')) {
    if (last.role === 'user') return call('preview', { action: 'open', target: '/home/agent/guestbook/index.html' });
    if (last.content.startsWith('Opened')) return call('preview', { action: 'type', ref: 1, value: 'Ada was here', submit: true });
    if (last.content.startsWith('typed into')) return call('preview', { action: 'snapshot' });
    if (last.content.startsWith('Page:') && !last.content.includes('EVAL')) return call('preview', { action: 'eval', code: "'EVAL ' + document.querySelectorAll('li').length" });
    if (last.content.startsWith('EVAL')) return call('preview', { action: 'screenshot' });
    if (last.content.startsWith('Screenshot')) return text(`PREVIEW DONE ${msgs.filter((m) => m.role === 'tool').map((m) => m.content.split('\n')[0]).join(' | ')}`);
  }
  // Web search in the browser: search, then read a page that does not let web pages read it.
  if (lastUser.includes('look it up on the web')) {
    if (last.role === 'user') return call('web_search', { query: 'Riemann hypothesis', max_results: 3 });
    if (last.content.startsWith('Results from')) return call('web_fetch', { url: 'https://www.iana.org/help/example-domains', max_chars: 3000 });
    return text(`WEB DONE ${msgs.filter((m) => m.role === 'tool').map((m) => m.content.slice(0, 400).replace(/\n/g, ' / ')).join(' | ')}`);
  }
  // Background jobs: start one, keep going, then read how it ended.
  if (lastUser.includes('count in the background')) {
    if (last.role === 'user') return call('shell', { command: 'echo start; sleep 2; echo finished', background: true });
    if (last.content.startsWith('Started job')) return call('job', { action: 'output', id: 'job1', wait_ms: 10000 });
    return text(`JOB DONE ${msgs.filter((m) => m.role === 'tool').map((m) => m.content.replace(/\n/g, ' / ')).join(' | ')}`);
  }
  if (last.role === 'tool') return text(`Tool said: ${last.content.slice(0, 200)}`);
  if (lastUser.includes('serve the todo app')) return call('dev_server', { action: 'start', path: 'todo' });
  if (lastUser.includes('Plan mode')) return text('1. Read notes.txt\n2. Change the second line\n3. Check the result');
  if (lastUser.includes('change the notes')) return call('read_file', { path: 'notes.txt' });
  if (lastUser.includes('Go ahead with the plan')) return text('Plan done.');
  if (lastUser.includes('use the web-page skill')) return call('use_skill', { name: 'web-page' });
  if (lastUser.includes('compute with python')) return call('shell', { command: 'pkg install python' });
  if (lastUser.includes('delegate to explorer')) return call('spawn_agent', { task: 'list the workspace', agent: 'explorer' });
  if (system.includes('Your role: explorer')) return text('EXPLORER REPORT: nothing to see');
  if (lastUser.includes('weather please')) return call('mcp__weather__forecast', { city: 'Pune' });
  if (lastUser.includes('make a sales table')) return call('create_artifact', { title: 'Sales by region', kind: 'csv', content: 'region,amount\nWest,30\nEast,120\nNorth,7\n' });
  if (lastUser.includes('write the report')) return call('create_artifact', { title: 'Weekly report', kind: 'markdown', content: '# Weekly report\n\nAll good.' });
  if (lastUser.includes('improve the report')) return call('update_artifact', { id: 'weekly-report', edits: [{ old: 'All good.', new: 'All good, shipped 3 features.' }], note: 'more detail' });
  // Interactive replies: a ```ui block, then what its clicks and forms send back.
  if (lastUser.startsWith('Plan: ') || lastUser.startsWith('Form “details”')) return text(`GOT ${lastUser.replace(/\n/g, ' / ')}`);
  if (lastUser.includes('show me the dashboard'))
    return text(
      [
        'Here is the overview:',
        '```ui',
        'root = Stack([head, stats, chart, table, plan, form, steps, more])',
        'head = Callout("Sales are **up** this week.", "ok")',
        'stats = Stats([Stat("Revenue", "$12.4k", "+8%"), Stat("Orders", 182, "-3%")])',
        'chart = Chart("bar", ["Mon", "Tue", "Wed"], [Series("This week", [5, 9, 7]), Series("Last week", [4, 6, 8])], "Orders per day")',
        'table = Table(["Region", "Sales"], [["West", 30], ["East", 120], ["North", 7]])',
        'plan = Choices("plan", "Plan", ["Basic", "Pro"])',
        'form = Form("details", [Input("name", "Your name"), Select("size", "Team size", ["1-5", "6-20"]), Checkbox("news", "Send news")], "Send details")',
        'steps = Checklist([Item("Import data", true), "Review"])',
        'more = Buttons([Button("Open the report", @Open("/home/agent/report.html")), Button("Docs", @OpenUrl("https://example.com"))])',
        '```',
        'Pick a plan when ready.',
      ].join('\n'),
    );
  if (lastUser.includes('flaky') || lastUser.includes('broken')) return text(`ANSWERED ${lastUser}`);
  if (lastUser.includes('where are you working')) return call('shell', { command: 'pwd' });
  if (lastUser.includes('isolated edit')) return call('shell', { command: 'echo v2 > iso/hello.txt && rm iso/gone.txt && echo new > iso/added.txt && pwd' });
  if (lastUser.includes('make yourself a profile')) return call('shell', { command: 'profile new Evil' });
  if (lastUser.includes('touch while away')) return call('shell', { command: 'touch /home/user/away.txt' });
  if (lastUser.includes('run the risky command')) return call('shell', { command: 'echo fine && rm -rf /home/user/keep' });
  return text(`echo: ${lastUser.slice(0, 120)}`);
}
// A package source for the package-manager check: a WASM package that needs a JS one, and one with a wrong sha256.
const pkgFiles = {
  'wasi-files.wasm': readFileSync(new URL('./fixtures/wasi-files.wasm', import.meta.url)),
  'hello.js': Buffer.from("print('hello ' + args.join(' '));"),
  'bad.js': Buffer.from("print('should never run');"),
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pkgIndex = {
  packages: [
    { id: 'wtest', version: '1.0.0', kind: 'wasm', summary: 'File test program', files: [{ path: 'wasi-files.wasm', url: 'http://localhost:11436/pkg/wasi-files.wasm', sha256: sha(pkgFiles['wasi-files.wasm']), bytes: pkgFiles['wasi-files.wasm'].length }], commands: { wtest: { run: 'wasi-files.wasm' } }, depends: ['jshello>=1.0'] },
    { id: 'jshello', version: '1.2.0', kind: 'js', summary: 'Says hello', files: [{ path: 'hello.js', url: 'http://localhost:11436/pkg/hello.js', sha256: sha(pkgFiles['hello.js']) }], commands: { jshello: { run: 'hello.js' } } },
    { id: 'badsum', version: '1.0.0', kind: 'js', summary: 'Tampered', files: [{ path: 'bad.js', url: 'http://localhost:11436/pkg/bad.js', sha256: '0'.repeat(64) }], commands: { badsum: { run: 'bad.js' } } },
  ],
};
const llm = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.url === '/pkg/index.json') return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(pkgIndex));
  if (req.url?.startsWith('/pkg/') && pkgFiles[req.url.slice(5)]) return res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' }).end(pkgFiles[req.url.slice(5)]);
  const b = await body(req);
  if (req.url.endsWith('/models')) return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock' }] }));
  const r = JSON.parse(b);
  requests.push(r);
  promptTokens = Math.ceil(JSON.stringify(r.messages).length / 4);
  const lastText = JSON.stringify(r.messages.findLast((m) => m.role === 'user')?.content ?? '');
  // "slow" messages take a while, so the tests can act while the agent works.
  if (/\bslow\b/.test(lastText) && r.messages.at(-1).role === 'user') await new Promise((ok) => setTimeout(ok, 3000));
  // "flaky": overloaded twice, then fine (the agent retries by itself). "broken": refused once (the user retries).
  const failures = (failCounts[lastText] ??= 0);
  if (/\bflaky\b/.test(lastText) && failures < 2) return (failCounts[lastText]++, res.writeHead(503, cors).end('overloaded'));
  if (/\bbroken\b/.test(lastText) && failures < 1) return (failCounts[lastText]++, res.writeHead(400, cors).end('bad request, once'));
  res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).end(sse(respond(r)));
}).listen(11436);
const failCounts = {};

const browser = await chromium.launch();
// ignoreHTTPSErrors: some CI and sandbox networks re-sign TLS through a proxy the test browser does not trust (pip reaches pypi.org).
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
let failed = 0;
// ONLY=text runs just the checks whose name has it (for self-contained checks, which open their own window).
const only = process.env.ONLY;
const check = async (name, fn) => {
  if (only && !name.includes(only)) return;
  try {
    const out = await fn();
    console.log(`ok   ${name}${out === undefined ? '' : ' → ' + (typeof out === 'string' ? out : JSON.stringify(out))}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${JSON.stringify(err.message.slice(0, 500))}`);
  }
};
/** What the agent window looks like, for failure messages. */
const dump = () => page.evaluate(() => `queued=${document.querySelectorAll('.cp-queued').length} stop=${!!document.querySelector('.cp-send.stop:not([hidden])')} live=${document.querySelectorAll('.sb-live').length} input=${JSON.stringify(document.querySelector('.ag-input')?.value)} log=…${document.querySelector('.ag-log')?.textContent.slice(-250)}`);
const send = async (msg, until) => {
  const before = requests.length;
  await page.locator('.ag-input').fill(msg);
  await page.locator('.ag-input').press('Enter');
  await page.waitForFunction(() => !document.querySelector('.cp-send.stop:not([hidden])'), null, { timeout: 30000 });
  if (until) await page.waitForFunction((t) => document.querySelector('.ag-log')?.textContent.includes(t), until, { timeout: 10000 });
  return requests.slice(before);
};
const term = async (cmd, waitFor, timeout = 60000) => {
  const input = page.locator('.term-input').last();
  await input.fill(cmd);
  await input.press('Enter');
  await page.waitForFunction((t) => document.querySelector('.term-out')?.textContent.includes(t), waitFor, { timeout });
  return page.evaluate(() => document.querySelector('.term-out').textContent);
};

await page.goto(base + 'agent/');
await check('first boot: setup in the console connects to a local model server', async () => {
  // skip the name and the API key · local server URL (it has one model, picked automatically)
  const answers = ['', '', 'http://localhost:11436/v1'];
  for (const a of answers) {
    await page.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 30000 });
    await page.locator('.boot-console .term-input').fill(a);
    await page.locator('.boot-console .term-input').press('Enter');
  }
  await page.waitForSelector('.ag-input', { timeout: 120000 });
  const out = await page.evaluate(() => ({ cfg: bbx.settings.get('agent.config', {}), perms: bbx.perms.mode, installed: bbx.settings.get('pkg.installed', []) }));
  if (out.cfg.localModel !== 'mock' || out.perms !== 'ask' || out.installed.join() !== 'git,sqlite,zip') throw new Error(JSON.stringify(out));
  // The rest of this suite runs without prompts and with a small window so compaction triggers.
  await page.evaluate(() => {
    bbx.perms.mode = 'auto';
    bbx.settings.set('agent.config', { ...bbx.settings.get('agent.config', {}), contextWindow: 16384 });
  });
  return `model ${out.cfg.localModel} @ ${out.cfg.localBaseUrl}; installed ${out.installed.join(', ')}`;
});

await check('example skills, agents and commands are seeded', () =>
  page.evaluate(async () => {
    const names = await Promise.all(['skills', 'agents', 'commands'].map((d) => bbx.fs.readdir(`/home/agent/${d}`).then((l) => l.map((e) => e.name).join(','))));
    if (!names[0].includes('web-page') || !names[1].includes('explorer.md') || !names[2].includes('explain.md')) throw new Error(names.join(' | '));
    return names.join(' | ');
  }),
);

await check('pkg: remove, install with a progress bar, list and info', async () => {
  await page.evaluate(() => bbx.openApp('terminal'));
  await page.waitForSelector('.term-input');
  const out = await term('pkg remove zip; pkg install zip && pkg list && pkg info zip', 'commands: zip, unzip');
  if (!/zip\s+\[#{24}\] 100%/.test(out)) throw new Error(`no completed progress bar: ${out.slice(-600)}`);
  if (/\[#{0,23}\.+\]/.test(out)) throw new Error('intermediate progress lines were not redrawn in place');
  if (!/i zip\s+\d+(\.\d)? KB/.test(out)) throw new Error(`list: ${out.slice(-500)}`);
  const cached = await page.evaluate(async () => (await (await caches.open('bbx-packs')).keys()).some((r) => /pkg-zip-/.test(r.url)));
  if (!cached) throw new Error('zip files are not in the package cache');
  return out.split('\n').find((l) => /^size:/.test(l));
});

await check('the agent installs a missing package and uses its tool in the same task', async () => {
  const reqs = await send('compute with python', 'Tool said: 42');
  if (reqs[0].tools.some((t) => t.function.name === 'run_python')) throw new Error('python was already installed');
  if (!/Not installed:[^\n]*\bpython \(/.test(reqs[0].messages[0].content)) throw new Error('the prompt does not offer python');
  if (!reqs[1].tools.some((t) => t.function.name === 'run_python')) throw new Error('run_python was not offered after installing');
  return `${reqs.length} model calls: pkg install python → run_python → answer`;
});

await check('environment variables reach the shell, JavaScript and Python', async () => {
  await page.evaluate(() => bbx.settings.set('env.vars', { GREETING: 'hello-env' }));
  await page.evaluate(() => bbx.openApp('terminal'));
  await page.locator('.wb-tab', { hasText: 'Terminal' }).first().click();
  // A fresh shell picks up the variable.
  await page.locator('.wb-head [aria-label*="Close Terminal"], .wb-tab:has-text("Terminal") .wb-tab-close').first().click();
  await page.evaluate(() => bbx.openApp('terminal'));
  await page.waitForSelector('.term-input');
  const out = await term('pkg install python >/dev/null && echo sh=$GREETING && js -e "return \'js=\' + env.GREETING" && python -c "import os; print(\'py=\' + os.environ[\'GREETING\'])" && echo env-done', '\nenv-done\n', 180000);
  for (const want of ['sh=hello-env', 'js=hello-env', 'py=hello-env']) if (!out.includes(want)) throw new Error(`${want} missing: ${out.slice(-500)}`);
  const pyCached = await page.evaluate(async () => (await (await caches.open('bbx-packs')).keys()).some((r) => r.url.endsWith('pyodide.asm.wasm')));
  if (!pyCached) throw new Error('the Python runtime was not kept in the pack cache');
  return 'sh, js and python all see GREETING; Python runtime cached on device';
});

await check('skills: listed in the prompt and loaded with use_skill', async () => {
  await page.locator('.wb-head button[aria-label*="lose"]').last().click().catch(() => {});
  const reqs = await send('use the web-page skill', 'Tool said');
  const system = reqs[0].messages[0].content;
  if (!system.includes('# Skills') || !system.includes('- web-page:')) throw new Error('skills missing from the system prompt');
  const result = reqs.at(-1).messages.at(-1).content;
  if (!result.includes('# Skill: web-page') || !result.includes('Inline the CSS')) throw new Error(result.slice(0, 300));
  return 'web-page instructions returned to the model';
});

await check('custom agents: explorer runs with only its allowed tools', async () => {
  const reqs = await send('delegate to explorer', 'EXPLORER REPORT');
  const child = reqs.find((r) => r.messages[0].content.includes('Your role: explorer'));
  if (!child) throw new Error('no request from the explorer agent');
  const tools = child.tools.map((t) => t.function.name).sort().join(',');
  if (tools !== 'glob,grep,list_dir,read_file') throw new Error(`explorer had tools: ${tools}`);
  return `explorer tools: ${tools}`;
});

await check('slash commands: menu lists commands; a custom one expands its template', async () => {
  await page.locator('.ag-input').fill('/ex');
  await page.waitForSelector('.sc-menu:not([hidden]) .sc-item');
  const shown = await page.locator('.sc-item .sc-name').allTextContents();
  if (!shown.includes('/explain')) throw new Error(shown.join(','));
  await page.locator('.ag-input').fill('');
  const reqs = await send('/explain notes.txt', 'echo:');
  const user = reqs[0].messages.findLast((m) => m.role === 'user').content;
  if (!user.startsWith('Explain notes.txt in plain language')) throw new Error(user);
  return `menu: ${shown.join(' ')}; sent: "${user.slice(0, 40)}…"`;
});

await check('connectors: add an MCP server, test it, and the agent calls its tool', async () => {
  await page.evaluate(() => bbx.openApp('settings', { section: 'connectors' }));
  await page.locator('.st-panel input[placeholder="e.g. github"]').fill('weather');
  await page.locator('.st-panel input[type=url]').fill('http://localhost:11437/mcp');
  await page.locator('.st-panel input[type=password]').fill('s3cret');
  await page.getByRole('button', { name: 'Add connector' }).click();
  await page.locator('.cn-row', { hasText: 'weather' }).getByRole('button', { name: 'Test' }).click();
  await page.waitForSelector('.cn-result .st-ok');
  const tested = await page.locator('.cn-result').textContent();
  const leaked = await page.evaluate(() => JSON.stringify(bbx.settings.get('mcp.servers', [])).includes('s3cret'));
  if (leaked) throw new Error('the token was stored in plain settings');
  await page.keyboard.press('Escape');
  const reqs = await send('weather please', 'Sunny in Pune');
  if (!reqs[0].tools.some((t) => t.function.name === 'mcp__weather__forecast')) throw new Error('the MCP tool was not offered to the model');
  if (!mcpCalls.length || mcpCalls[0].session !== 'sess-1') throw new Error(`MCP call: ${JSON.stringify(mcpCalls)}`);
  return `${tested.trim().slice(0, 60)} · tool called with session`;
});

await check('context meter shows usage and a breakdown', async () => {
  await page.waitForSelector('.cm:not([hidden])');
  await page.locator('.cm-btn').click();
  const panel = await page.locator('.cm-panel').textContent();
  for (const want of ['Context window', 'System prompt', 'Tool definitions', 'Tool results', 'Free', 'Compact now']) if (!panel.includes(want)) throw new Error(`missing ${want}`);
  const pct = await page.locator('.cm-pct').textContent();
  await page.keyboard.press('Escape');
  return `meter at ${pct}`;
});

await check('/compact summarises: the model then sees only the summary, the chat keeps everything', async () => {
  const visibleBefore = await page.locator('.ag-msg.user').count();
  const before = requests.length;
  await page.locator('.ag-input').fill('/compact');
  await page.locator('.ag-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('Conversation summarised'), null, { timeout: 20000 });
  if (!requests.slice(before).some((r) => r.messages.at(-1).content.includes('Your context window is nearly full'))) throw new Error('no compaction request');
  const reqs = await send('after compaction', 'echo:');
  const seen = reqs[0].messages.filter((m) => m.role !== 'system');
  if (!seen[0].content.includes('SUMMARY: the user asked about skills') || seen.length !== 2) throw new Error(`model saw ${seen.length} messages: ${JSON.stringify(seen).slice(0, 300)}`);
  const visibleAfter = await page.locator('.ag-msg.user').count();
  if (visibleAfter !== visibleBefore + 1) throw new Error(`chat history shrank: ${visibleBefore} → ${visibleAfter}`);
  return `model context: summary + 1 message; chat shows ${visibleAfter} user messages`;
});

await check('automatic compaction when the context is nearly full', async () => {
  await page.evaluate(() => bbx.settings.set('agent.config', { ...bbx.settings.get('agent.config', {}), contextWindow: 2048 }));
  await send('a'.repeat(4000), 'echo:');
  const before = requests.length;
  await send('next message', 'echo:');
  const compacted = requests.slice(before).some((r) => r.messages.at(-1).content.includes('Your context window is nearly full'));
  if (!compacted) throw new Error('did not compact');
  return 'compacted before the next message';
});

await check('compacted sessions reload with their full history', async () => {
  const visible = await page.locator('.ag-msg.user').count();
  await page.reload();
  await page.waitForFunction((n) => document.querySelectorAll('.ag-msg.user').length === n, visible, { timeout: 15000 }).catch(async () => {
    const info = await page.evaluate(async () => {
      const live = await bbx.agents.live();
      const files = await bbx.fs.readdir('/home/agent/.sessions');
      return { live, files: files.map((f) => f.name), shown: document.querySelectorAll('.ag-msg.user').length, empty: document.querySelector('.bb')?.className };
    });
    throw new Error(`expected ${visible}: ${JSON.stringify(info)}`);
  });
  return `${visible} user messages restored`;
});

await check('private chat: never saved, not listed, gone after leaving it', async () => {
  const sessions = async () => page.evaluate(async () => (await bbx.fs.readdir('/home/agent/.sessions')).length);
  await page.locator('.bb-more').click();
  await page.locator('.menu .pop-item', { hasText: 'New chat' }).click();
  const before = await sessions();
  await page.locator('.bb-private').click();
  await page.waitForSelector('.bb.is-private');
  await send('a private thought', 'echo: a private thought');
  const listed = await page.evaluate(async () => (await bbx.agents.live()).length);
  if ((await sessions()) !== before) throw new Error('the private chat was written to disk');
  await page.locator('.bb-more').click();
  await page.locator('.menu .pop-item', { hasText: 'New chat' }).click();
  await page.waitForFunction(() => !document.querySelector('.bb.is-private') && !document.querySelector('.ag-log')?.textContent.includes('a private thought'));
  if ((await sessions()) !== before) throw new Error('saved on leaving');
  return `not on disk; ${listed} live sessions listed while it ran, none of them private`;
});

await check('side panel: minimise, expand, and a draggable bottom sheet on phones', async () => {
  await page.evaluate(() => bbx.openApp('files'));
  await page.waitForSelector('.wb:not([hidden]) .wb-pane[data-app="files"]');
  await page.locator('.wb-min-btn').click();
  const min = await page.evaluate(() => ({ size: document.querySelector('.wb').dataset.size, w: document.querySelector('.wb').getBoundingClientRect().width, panes: getComputedStyle(document.querySelector('.wb-panes')).display }));
  if (min.size !== 'min' || min.w > 60 || min.panes !== 'none') throw new Error(JSON.stringify(min));
  await page.locator('.wb-min-btn').click();
  await page.locator('.wb-max-btn').click();
  const full = await page.evaluate(() => ({ main: getComputedStyle(document.querySelector('.bb-main')).display, w: document.querySelector('.wb').getBoundingClientRect().width }));
  if (full.main !== 'none' || full.w < 900) throw new Error(JSON.stringify(full));
  await page.locator('.wb-max-btn').click();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(400); // the sheet slides in
  const grab = await page.locator('.wb-grab').boundingBox();
  const h0 = await page.evaluate(() => document.querySelector('.wb').getBoundingClientRect().height);
  await page.mouse.move(grab.x + grab.width / 2, grab.y + 8);
  await page.mouse.down();
  await page.mouse.move(grab.x + grab.width / 2, grab.y + 208, { steps: 6 });
  await page.mouse.up();
  const h1 = await page.evaluate(() => document.querySelector('.wb').getBoundingClientRect().height);
  if (!(h1 < h0 - 150)) throw new Error(`sheet ${h0} → ${h1}`);
  await page.mouse.move(grab.x + grab.width / 2, grab.y + 208);
  await page.mouse.down();
  await page.mouse.move(grab.x + grab.width / 2, 790, { steps: 6 });
  await page.mouse.up();
  const size = await page.evaluate(() => document.querySelector('.wb').dataset.size);
  if (size !== 'min') throw new Error(`dragging down did not minimise: ${size}`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('.wb-min-btn').click();
  return `desktop strip ${Math.round(min.w)}px, full width ${Math.round(full.w)}px; phone sheet ${Math.round(h0)} → ${Math.round(h1)}px → minimised`;
});

await check('editor: Markdown preview replaces the code instead of stacking under it', async () => {
  await page.evaluate(() => bbx.fs.writeFile('/home/agent/readme.md', '# Hello\n\nSome *text*.'));
  await page.evaluate(() => bbx.openApp('editor', { path: '/home/agent/readme.md' }));
  const pane = page.locator('.wb-pane[data-app="editor"]');
  await pane.locator('[aria-label="Toggle Markdown preview"]').click();
  await pane.locator('.md-preview h1').waitFor({ timeout: 5000 });
  const on = await pane.evaluate((el) => ({ code: el.querySelector('.code')?.checkVisibility(), h1: el.querySelector('h1')?.textContent }));
  if (on.code || on.h1 !== 'Hello') throw new Error(JSON.stringify(on));
  await pane.locator('[aria-label="Toggle Markdown preview"]').click();
  if (!(await pane.evaluate((el) => el.querySelector('.code')?.checkVisibility()))) throw new Error('the code did not come back');
  return 'Preview ⇄ Edit swap';
});

await check('preview runs a page’s scripts (sandboxed, own origin)', async () => {
  // The page gets storage of its own (kept per app), never the app's: its origin is opaque.
  await page.evaluate(() => localStorage.setItem('bbx-probe', 'app-only'));
  await page.evaluate(() => bbx.openApp('preview', { html: '<p id="x">waiting</p><script>document.getElementById("x").textContent = "js-ran origin=" + self.origin + " probe=" + localStorage.getItem("bbx-probe")</script>' }));
  const frame = await (await page.waitForSelector('.wb-pane[data-app="preview"]:not([hidden]) iframe.pv-frame')).contentFrame();
  await frame.waitForFunction(() => document.getElementById('x')?.textContent.startsWith('js-ran'), null, { timeout: 10000 });
  const t = await frame.locator('#x').textContent();
  if (t !== 'js-ran origin=null probe=null') throw new Error(`the page reached the app's origin or storage: ${t}`);
  return t;
});

const TODO = {
  'package.json': JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }),
  'index.html': '<!doctype html><html><head><title>Todo</title><link rel="stylesheet" href="/src/app.css"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  'src/app.css': 'h1 { color: rgb(0, 128, 128) }',
  'src/main.tsx': `import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { title } from '@/title';
type Todo = { id: number; text: string };
function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  useEffect(() => { fetch('/api/todos').then((r) => r.json()).then(setTodos); }, []);
  const add = async () => setTodos(await (await fetch('/api/todos', { method: 'POST', body: JSON.stringify({ text: 'item ' + todos.length }) })).json());
  return <main><h1>{title}</h1><ul>{todos.map((t) => <li key={t.id}>{t.text}</li>)}</ul><button id="add" onClick={add}>Add</button><img id="logo" src="/logo.svg" /></main>;
}
console.log('todo app booted');
fetch('/missing.json');
createRoot(document.getElementById('root')!).render(<App />);`,
  'src/title.ts': 'export const title: string = "Todos";',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  'server.ts': `const todos = [{ id: 1, text: 'from the backend' }];
export default {
  async fetch(req: Request, env: { fs: { writeFile(p: string, d: string): Promise<void> } }) {
    const url = new URL(req.url);
    if (url.pathname !== '/api/todos') return null;
    if (req.method === 'POST') { todos.push({ id: todos.length + 1, ...(await req.json()) }); console.log('saved', todos.length); await env.fs.writeFile('todos.json', JSON.stringify(todos)); }
    return Response.json(todos);
  },
};`,
};

await check('dev server: React + TypeScript + backend, reloading on save', async () => {
  await page.evaluate(async (files) => { for (const [k, v] of Object.entries(files)) await bbx.fs.writeFile(`/home/agent/todo/${k}`, v); }, TODO);
  await page.evaluate(() => bbx.openApp('terminal'));
  await page.waitForSelector('.term-input');
  const out = await term('cd /home/agent/todo && npm run dev', 'localhost:3000', 120000);
  const frame = await (await page.waitForSelector('.wb-pane[data-app="preview"]:not([hidden]) iframe.pv-frame', { timeout: 60000 })).contentFrame();
  await frame.waitForSelector('li', { timeout: 120000 });
  await frame.locator('#add').click();
  await frame.waitForFunction(() => document.querySelectorAll('li').length === 2, null, { timeout: 15000 });
  await frame.waitForFunction(() => document.getElementById('logo')?.src.startsWith('blob:'), null, { timeout: 10000 });
  const saved = await page.evaluate(() => bbx.fs.readText('/home/agent/todo/todos.json'));
  if (!saved.includes('item 1')) throw new Error(`backend did not write: ${saved}`);
  // Saving a file reloads the page; the backend keeps its in-memory state.
  await page.evaluate(() => bbx.fs.writeFile('/home/agent/todo/src/app.css', 'h1 { color: rgb(200, 0, 0) }'));
  await page.waitForFunction(async () => {
    const f = document.querySelector('.wb-pane[data-app="preview"]:not([hidden]) iframe.pv-frame');
    return !!f;
  });
  let color = '';
  for (let i = 0; i < 40 && color !== 'rgb(200, 0, 0)'; i++) {
    await page.waitForTimeout(250);
    const f = await (await page.$('.wb-pane[data-app="preview"]:not([hidden]) iframe.pv-frame'))?.contentFrame();
    color = (await f?.evaluate(() => document.querySelector('h1') && getComputedStyle(document.querySelector('h1')).color).catch(() => '')) ?? '';
  }
  if (color !== 'rgb(200, 0, 0)') throw new Error(`no reload after saving: ${color}`);
  const f2 = await (await page.$('.wb-pane[data-app="preview"]:not([hidden]) iframe.pv-frame')).contentFrame();
  await f2.waitForFunction(() => document.querySelectorAll('li').length === 2, null, { timeout: 15000 });
  const logs = await page.evaluate(() => bbx.dev.logs(3000).then((l) => l.map((x) => `${x.source}/${x.level}: ${x.text}`)));
  for (const want of ['page/log: todo app booted', 'server/log: saved 2', 'network/warn: GET /missing.json → 404']) if (!logs.some((l) => l.startsWith(want))) throw new Error(`${want} missing from ${JSON.stringify(logs)}`);
  await page.locator('.wb-pane[data-app="preview"]:not([hidden]) button[aria-label="Console"]').click();
  const shown = await page.locator('.wb-pane[data-app="preview"]:not([hidden]) .pv-log-row').count();
  if (!shown) throw new Error('the console panel is empty');
  return `${out.includes('esbuild') ? 'installed esbuild; ' : ''}rendered, backend state kept across a reload, ${logs.length} log entries, ${shown} in the console`;
});

await check('agent: dev_server starts the app and preview_logs reads its console', async () => {
  await page.evaluate(() => bbx.dev.stop(3000));
  // Earlier checks shrank the context window to force compaction; give this one room.
  await page.evaluate(() => bbx.settings.set('agent.config', { ...bbx.settings.get('agent.config', {}), contextWindow: 128000 }));
  await page.locator('.bb-more').click();
  await page.locator('.menu .pop-item', { hasText: 'New chat' }).click();
  const before = requests.length;
  const reqs = await send('serve the todo app', 'Tool said').catch(async (err) => {
    throw new Error(`${err.message.split('\n')[0]} · model saw: ${JSON.stringify(requests.slice(before).map((r) => r.messages.at(-1)?.content?.slice?.(0, 300)))} · ${await page.evaluate(() => `queued=${document.querySelectorAll('.cp-queued').length} stop=${!!document.querySelector('.cp-send.stop:not([hidden])')} log=${document.querySelector('.ag-log')?.textContent.slice(-300)} notes=${[...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|')}`)}`);
  });
  const results = reqs.flatMap((r) => r.messages.filter((m) => m.role === 'tool').map((m) => m.content));
  const started = results.find((c) => c.startsWith('Serving'));
  const logs = results.find((c) => /entr(y|ies)/.test(c));
  if (!started || !started.includes('Backend: server.ts')) throw new Error(`dev_server: ${started}`);
  if (!logs || !logs.includes('todo app booted')) throw new Error(`preview_logs: ${logs}`);
  await page.evaluate(() => bbx.dev.stop(3000));
  return started.split('\n')[0];
});

await check('preview: full screen and back, on desktop and phone', async () => {
  await page.evaluate(() => bbx.openApp('preview', { html: '<h1 id="t">big</h1>' }));
  const pane = page.locator('.wb-pane[data-app="preview"]:not([hidden])');
  await pane.locator('iframe.pv-frame').waitFor();
  const sizes = [];
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 800 }, { width: 390, height: 800, noApi: true }]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // iPhone Safari has no element full screen: the view is pinned over the window instead.
    if (vp.noApi) await page.evaluate(() => Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false }));
    await page.waitForTimeout(400);
    await pane.locator('button[aria-label="Full screen"]').click();
    await page.waitForTimeout(400);
    const r = await pane.locator('.pv-fs').evaluate((el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), api: document.fullscreenElement === el }; });
    if (r.w < vp.width - 2 || r.h < vp.height - 2) throw new Error(`not full screen at ${vp.width}px: ${JSON.stringify(r)}`);
    await page.locator('.pv-fs-exit').click();
    await page.waitForTimeout(300);
    if (await page.locator('.pv-fs').count()) throw new Error('did not leave full screen');
    sizes.push(`${vp.width}px: ${r.w}×${r.h}${r.api ? ' (Fullscreen API)' : ' (pinned)'}`);
  }
  await page.evaluate(() => delete document.fullscreenEnabled);
  await page.setViewportSize({ width: 1280, height: 800 });
  return sizes.join(', ');
});

await check('pip: install from PyPI, import it, and it stays installed in a new interpreter', async () => {
  await page.evaluate(() => bbx.openApp('terminal'));
  await page.waitForSelector('.term-input');
  page.on('pageerror', () => {});
  const dump = () => page.evaluate(() => [...document.querySelectorAll('.term-out')].map((t) => t.textContent.slice(-700)).join(' ||| '));
  try {
    await term('echo pip-start', 'pip-start', 20000);
  } catch (err) {
    throw new Error(`terminal not ready: ${await dump()}`);
  }
  const out = await term('cd /home/agent && pip install snowballstemmer && python -c "import snowballstemmer; print(\'stem=\' + snowballstemmer.stemmer(\'english\').stemWord(\'running\'))" && python -V && echo pip-done', '\npip-done\n', 180000).catch(async (err) => {
    throw new Error(`${err.message.split('\n')[0]}: ${await dump()}`);
  });
  if (!out.includes('Successfully installed snowballstemmer') || !out.includes('stem=run')) throw new Error(out.slice(-600));
  const version = out.match(/Python 3\.\d+\.\d+ \(Pyodide [\d.]+\)/)?.[0];
  if (!version) throw new Error(`no version: ${out.slice(-300)}`);
  // A new interpreter (the old one killed) reinstalls what pip installed.
  await page.evaluate(() => { const p = bbx.procs.list().find((x) => x.name === 'python'); if (p) bbx.procs.kill(p.pid); });
  const again = await term('python -c "import snowballstemmer; print(\'again-ok\')"', 'again-ok', 180000);
  if (!again.includes('again-ok')) throw new Error(again.slice(-300));
  return `${version}; snowballstemmer installed and remembered`;
});

let desk;
await check('desktop: right-click menu, new folder on the desktop, wallpaper, snapping', async () => {
  desk = await context.newPage();
  desk.on('pageerror', (e) => errors.push(`desktop pageerror: ${e.message}`));
  await desk.goto(base + 'os/');
  await desk.waitForSelector('.taskbar', { timeout: 60000 });
  await desk.mouse.click(700, 400, { button: 'right' });
  await desk.locator('.menu .pop-item', { hasText: 'New folder' }).click();
  await desk.locator('.modal input').fill('Projects');
  await desk.locator('.modal button[type="submit"]').click();
  await desk.locator('.desk-icon', { hasText: 'Projects' }).waitFor({ timeout: 10000 });
  if (!(await desk.evaluate(() => bbx.fs.exists('/home/user/Desktop/Projects')))) throw new Error('folder not created');
  const before = await desk.locator('.wallpaper').evaluate((el) => el.style.background);
  // A light theme repaints the wallpaper in its colours, flagged light (dark icon labels).
  await desk.evaluate(() => bbx.settings.set('ui.theme', 'paper'));
  await desk.waitForFunction((b) => document.querySelector('.wallpaper').style.background !== b && document.querySelector('.wallpaper').dataset.light === 'true', before, { timeout: 15000 });
  if ((await desk.evaluate(() => document.documentElement.dataset.theme)) !== 'light') throw new Error('the page did not switch to the light theme');
  await desk.evaluate(() => bbx.settings.set('ui.theme', 'system'));
  await desk.locator('.desk-icon', { hasText: 'Files' }).dblclick();
  await desk.waitForSelector('.win-body[data-app="files"]');
  const bar = await desk.locator('.win-bar').first().boundingBox();
  await desk.mouse.move(bar.x + 120, bar.y + 15);
  await desk.mouse.down();
  await desk.mouse.move(1278, 300, { steps: 10 });
  await desk.mouse.up();
  const r = await desk.locator('.win').first().evaluate((el) => ({ left: el.offsetLeft, width: el.offsetWidth, area: el.parentElement.offsetWidth }));
  if (Math.abs(r.width - r.area / 2) > 2 || Math.abs(r.left - r.area / 2) > 2) throw new Error(`not snapped right: ${JSON.stringify(r)}`);
  // The agent opens as a window on the desktop; "Open in new tab" gives it a browser tab.
  await desk.evaluate(() => document.querySelector('.taskbar .show-desk').click());
  await desk.locator('.desk-icon', { hasText: 'Agent' }).dblclick();
  const frame = await (await desk.waitForSelector('.win iframe.win-page', { timeout: 10000 })).contentFrame();
  await frame.waitForSelector('.ag-input', { timeout: 60000 });
  const inFrame = await frame.evaluate(() => [...document.querySelectorAll('.sb-desktop')].map((b) => b.textContent).join());
  if (!inFrame.includes('Open in new tab')) throw new Error(`embedded agent offers: ${inFrame}`);
  await desk.locator('.desk-icon', { hasText: 'Agent' }).click({ button: 'right' });
  const [tab] = await Promise.all([context.waitForEvent('page'), desk.locator('.menu .pop-item', { hasText: 'Open in new tab' }).click()]);
  await tab.waitForLoadState();
  if (!tab.url().includes('/agent/')) throw new Error(`new tab: ${tab.url()}`);
  await tab.close();
  await desk.locator('.win:has(iframe.win-page) .win-ctl .close').click();
  return 'folder created, wallpaper switched, window snapped right, agent opened as a window and in a new tab';
});

await check('phone: home screen, apps fill the screen, the home bar goes home and shows recents', async () => {
  let step = 'start';
  try {
  await desk.setViewportSize({ width: 390, height: 844 });
  await desk.waitForSelector('.phone-home');
  // Windows left open on the desktop now fill the phone screen: go home first.
  const bar0 = await desk.locator('.home-bar').boundingBox();
  await desk.mouse.click(bar0.x + bar0.width / 2, bar0.y + 8);
  await desk.waitForFunction(() => !document.getElementById('desk').classList.contains('app-open'));
  await desk.locator('.home-app[data-id="files"]').click();
  await desk.waitForFunction(() => document.getElementById('desk').classList.contains('app-open'));
  await desk.waitForTimeout(400); // the opening animation
  const r = await desk.locator('.win:not(.min)').last().boundingBox();
  if (r.width < 389 || r.height < 700) throw new Error(`app does not fill the screen: ${JSON.stringify(r)}`);
  const pill = await desk.locator('.home-bar').boundingBox();
  await desk.mouse.click(pill.x + pill.width / 2, pill.y + 8);
  await desk.waitForFunction(() => !document.getElementById('desk').classList.contains('app-open'));
  step = 'long press';
  // Long press: recent apps; tapping a card reopens it.
  await desk.mouse.move(pill.x + pill.width / 2, pill.y + 8);
  await desk.mouse.down();
  await desk.waitForTimeout(700);
  await desk.mouse.up();
  await desk.waitForSelector('.desk-area.switching');
  step = 'tap card';
  const cards = await desk.locator('.switching .win').count();
  // The front card is the most recent app.
  const card = await desk.evaluate(() => { const r = [...document.querySelectorAll('.switching .win')].find((w) => w.style.getPropertyValue('--i') === '0').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await desk.mouse.click(card.x + card.width / 2, card.y + card.height / 2);
  await desk.waitForFunction(() => !document.querySelector('.desk-area.switching') && document.getElementById('desk').classList.contains('app-open'));
  step = 'back';
  // Android's back button goes home rather than leaving.
  await desk.goBack().catch(() => undefined);
  await desk.waitForFunction(() => !document.getElementById('desk').classList.contains('app-open'), null, { timeout: 5000 });
  if (!desk.url().includes('/os/')) throw new Error(`back left the desktop: ${desk.url()}`);
  await desk.close();
  return `${cards} recent app${cards === 1 ? '' : 's'}; tap, long press and back all work`;
  } catch (err) {
    throw new Error(`${step}: ${err.message.split('\n')[0]} · ${await desk.evaluate(() => `${document.getElementById('desk').className} ${document.querySelector('.desk-area').className} wins=${[...document.querySelectorAll('.win')].map((w) => w.className).join('|')}`)}`);
  }
});

await check('composer: model picker under the message box; an empty chat sits in the middle', async () => {
  await page.locator('.bb-more').click();
  await page.locator('.menu .pop-item', { hasText: 'New chat' }).click();
  await page.waitForSelector('.bb.is-empty');
  const r = await page.evaluate(() => {
    const box = (s) => document.querySelector(s).getBoundingClientRect();
    return { input: box('.ag-input'), model: box('.composer .cp-model'), dock: box('.bb-dock'), main: box('.bb-main'), model_text: document.querySelector('.cp-model').textContent };
  });
  if (!(r.model.top >= r.input.bottom - 2)) throw new Error(`model picker is not below the input: ${JSON.stringify(r)}`);
  const mid = r.dock.top + r.dock.height / 2;
  if (!(mid > r.main.top + r.main.height * 0.3 && mid < r.main.top + r.main.height * 0.75)) throw new Error(`empty chat composer is not near the middle: ${mid} in ${r.main.height}`);
  if (r.input.height < 70) throw new Error(`empty chat message box is short: ${r.input.height}`);
  return `model "${r.model_text}" under the box; composer centre at ${Math.round(((mid - r.main.top) / r.main.height) * 100)}% of the height`;
});

await check('reply stats, session usage and the sandbox section of the system prompt', async () => {
  const reqs = await send('hello stats', 'echo: hello stats');
  await page.waitForSelector('.ag-stats');
  const stats = await page.locator('.ag-stats').last().textContent();
  if (!/out · .* context/.test(stats)) throw new Error(`stats: ${stats}`);
  await page.locator('.cm-btn').click();
  await page.waitForSelector('.cm-session');
  const session = await page.locator('.cm-session').textContent();
  await page.keyboard.press('Escape');
  if (!/Model calls\s*\d/.test(session) || !/Output tokens/.test(session)) throw new Error(`session: ${session}`);
  const system = reqs[0].messages[0].content;
  for (const want of ['The sandbox: what this machine is', 'No native toolchains', 'pip install', 'CORS']) if (!system.includes(want)) throw new Error(`system prompt lacks "${want}"`);
  return `${stats.trim()} · session panel shown · sandbox rules in the prompt`;
});

await check('in-browser models: download, use, delete, and import from a folder', async () => {
  const ID = 'SmolLM2-360M-Instruct-q4f16_1-MLC';
  // Tiny stand-ins for the model's files, served where WebLLM would fetch them.
  const shard = Buffer.alloc(4096, 7);
  await page.route(`https://huggingface.co/mlc-ai/${ID}/resolve/main/**`, (route) => {
    const name = route.request().url().split('/').pop();
    const body = name === 'mlc-chat-config.json' ? JSON.stringify({ tokenizer_files: ['tokenizer.json'] }) : name === 'tensor-cache.json' ? JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: shard.length }], metadata: {} }) : name === 'tokenizer.json' ? '{}' : name === 'params_shard_0.bin' ? shard : null;
    return body === null ? route.fulfill({ status: 404, body: 'no' }) : route.fulfill({ status: 200, body, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route(/raw\.githubusercontent\.com\/.*SmolLM2-360M.*\.wasm$/, (route) => route.fulfill({ status: 200, body: Buffer.from([0, 97, 115, 109]), headers: { 'access-control-allow-origin': '*' } }));
  await page.evaluate(() => bbx.openApp('settings', { section: 'model' }));
  await page.locator('.st-choice', { hasText: 'In this browser' }).click();
  const row = page.locator('.wl-row', { hasText: 'SmolLM2 360M Instruct' });
  await row.waitFor({ timeout: 30000 });
  await row.getByRole('button', { name: 'Download' }).click();
  await row.locator('.badge', { hasText: 'On this device' }).waitFor({ timeout: 20000 });
  await row.getByRole('button', { name: 'Use' }).click();
  await row.locator('.badge', { hasText: 'In use' }).waitFor();
  const cfg = await page.evaluate(() => bbx.settings.get('agent.config', {}));
  if (cfg.webgpuModel !== ID || cfg.provider !== 'webgpu') throw new Error(JSON.stringify(cfg));
  await row.getByRole('button', { name: 'Delete' }).click();
  await page.locator('.modal .btn.danger').click();
  await row.getByRole('button', { name: 'Download' }).waitFor({ timeout: 10000 });
  const left = await page.evaluate(async (id) => (await (await caches.open('webllm/model')).keys()).filter((k) => k.url.includes(id)).length, ID);
  if (left) throw new Error(`${left} files left after delete`);

  // Import a compiled model from a folder on the computer.
  const dir = join(mkdtempSync(join(tmpdir(), 'bbx-model-')), 'tiny-model');
  (await import('node:fs')).mkdirSync(dir);
  writeFileSync(join(dir, 'mlc-chat-config.json'), JSON.stringify({ model_id: 'tiny-model', context_window_size: 2048, tokenizer_files: ['tokenizer.json'] }));
  writeFileSync(join(dir, 'ndarray-cache.json'), JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 4 }], metadata: {} }));
  writeFileSync(join(dir, 'params_shard_0.bin'), Buffer.from([1, 2, 3, 4]));
  writeFileSync(join(dir, 'tokenizer.json'), '{}');
  writeFileSync(join(dir, 'tiny-model-webgpu.wasm'), Buffer.from([0, 97, 115, 109]));
  await page.locator('.wl input[type="file"]').setInputFiles(dir);
  const imported = page.locator('.wl-row', { hasText: 'tiny model' });
  await imported.locator('.badge', { hasText: 'In use' }).waitFor({ timeout: 15000 });
  const custom = await page.evaluate(() => bbx.settings.get('webllm.custom', []));
  const cached = await page.evaluate(async () => (await (await caches.open('webllm/model')).keys()).map((k) => k.url).filter((u) => u.includes('tiny-model')));
  if (custom[0]?.model_id !== 'tiny-model' || !cached.some((u) => u.endsWith('/tensor-cache.json'))) throw new Error(JSON.stringify({ custom, cached }));
  await page.locator('.sm-head [aria-label="Close settings"]').click();
  await page.evaluate(() => bbx.settings.set('agent.config', { ...bbx.settings.get('agent.config', {}), provider: 'local' }));
  await page.unroute(`https://huggingface.co/mlc-ai/${ID}/resolve/main/**`);
  return `downloaded, used and deleted ${ID}; imported tiny-model (${cached.length} files cached)`;
});

await check('diffs, the Changes panel, and editing a message rewinds chat and files', async () => {
  await page.locator('.bb-more').click();
  await page.locator('.menu .pop-item', { hasText: 'New chat' }).click();
  await page.evaluate(() => bbx.fs.writeFile('/home/agent/notes.txt', 'first\nsecond\nthird\n'));
  await page.evaluate(() => (bbx.perms.mode = 'auto'));
  await send('please change the notes', 'Tool said');
  // The tool card shows the diff.
  await page.waitForSelector('.ag-tool.has-diff .df-line.add');
  const stat = await page.locator('.ag-tool.has-diff .df-stat').first().textContent();
  if (!stat.includes('+1') || !stat.includes('−1')) throw new Error(`stat ${stat}`);
  // The chip and the panel list the file; undo there puts it back.
  await page.locator('.bb-changes:not([hidden])').waitFor();
  await page.locator('.bb-changes:not([hidden])').click();
  await page.locator('.ch-file', { hasText: 'notes.txt' }).waitFor();
  await page.locator('.ch-file button', { hasText: 'Undo' }).click();
  await page.waitForFunction(async () => (await bbx.fs.readText('/home/agent/notes.txt').catch(() => '')) === 'first\nsecond\nthird\n');
  await page.locator('.ch-empty').waitFor();
  await page.keyboard.press('Escape');
  // Redo the change, then edit the message: the chat and the file go back.
  await send('please change the notes again', 'Tool said');
  await page.waitForFunction(async () => (await bbx.fs.readText('/home/agent/notes.txt').catch(() => '')).includes('SECOND'));
  const userMsgs = page.locator('.ag-msg.user');
  await userMsgs.last().hover();
  await userMsgs.last().locator('[aria-label="Edit message"]').click();
  await page.locator('.modal button', { hasText: 'Undo file changes' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ag-msg.user').length === 1);
  const file = await page.evaluate(() => bbx.fs.readText('/home/agent/notes.txt'));
  const box = await page.locator('.ag-input').inputValue();
  if (file !== 'first\nsecond\nthird\n') throw new Error(`file not restored: ${JSON.stringify(file)}`);
  if (box !== 'please change the notes again') throw new Error(`composer: ${box}`);
  await page.locator('.ag-input').fill('');
  return `diff ${stat.trim()}, undone from the panel, rewound by editing`;
});

await check('plan mode: Shift+Tab, read-only tools, then Run the plan', async () => {
  await page.evaluate(() => (bbx.perms.mode = 'ask'));
  await page.locator('.ag-input').focus();
  for (let i = 0; i < 3 && (await page.locator('.cp-mode').getAttribute('data-mode')) !== 'plan'; i++) await page.keyboard.press('Shift+Tab');
  if ((await page.locator('.cp-mode').getAttribute('data-mode')) !== 'plan') throw new Error('Shift+Tab did not reach plan mode');
  const reqs = await send('plan a change to the notes', 'Check the result');
  const tools = reqs[0].tools.map((t) => t.function.name);
  if (tools.includes('write_file') || tools.includes('shell')) throw new Error(`plan mode offered ${tools.join(',')}`);
  if (!(await page.locator('.ag-msg.user .ag-mode-tag').count())) throw new Error('the message is not marked as a plan');
  await page.locator('.ag-choices button', { hasText: 'Run the plan' }).click();
  await page.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('Plan done.'), null, { timeout: 15000 });
  const mode = await page.locator('.cp-mode').getAttribute('data-mode');
  if (mode === 'plan') throw new Error('still in plan mode after running the plan');
  return `offered only ${tools.length} read-only tools; ran the plan in "${mode}" mode`;
});

await check('@mentions attach files; messages queue while the agent works', async () => {
  try {
  await page.evaluate(() => bbx.fs.writeFile('/home/agent/reference.md', '# Reference\nThe answer is 42.\n'));
  const input = page.locator('.ag-input');
  await input.fill('');
  await input.pressSequentially('read @refer');
  await page.locator('.mn-menu:not([hidden]) .sc-item', { hasText: 'reference.md' }).waitFor();
  await input.press('Enter');
  if (!(await input.inputValue()).includes('@reference.md')) throw new Error(`not inserted: ${await input.inputValue()}`);
  const before = requests.length;
  await input.press('Enter');
  await page.waitForFunction((n) => true, before);
  await page.waitForFunction(() => !document.querySelector('.cp-send.stop:not([hidden])'), null, { timeout: 20000 });
  const sentText = requests.slice(before).map((r) => r.messages.findLast((m) => m.role === 'user')?.content ?? '').join('\n');
  if (!sentText.includes('<file path="/home/agent/reference.md">') || !sentText.includes('The answer is 42.')) throw new Error(`file not attached: ${sentText.slice(0, 300)}`);
  if (!(await page.locator('.ag-file-chip', { hasText: 'reference.md' }).count())) throw new Error('no attachment chip');
  const titles = await page.evaluate(() => [...document.querySelectorAll('.sb-chat-title')].map((t) => t.textContent).join(' | '));
  if (titles.includes('<file')) throw new Error(`file contents leaked into a title: ${titles}`);

  // Queue: write while the agent works; it is sent when the agent finishes.
  const n0 = requests.length;
  await input.fill('a slow task');
  await input.press('Enter');
  await page.waitForSelector('.cp-send.stop:not([hidden])');
  await input.fill('and then this');
  await input.press('Enter');
  await page.locator('.cp-queued', { hasText: 'and then this' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('echo: and then this'), null, { timeout: 20000 });
  if (await page.locator('.cp-queued').count()) throw new Error('queue not emptied');
  return `file inlined with its chip; queued message sent after ${requests.length - n0} model calls`;
  } catch (err) {
    throw new Error(`${err.message.split('\n')[0]} · ${await dump()} · last requests: ${JSON.stringify(requests.slice(-3).map((r) => (r.messages.findLast((m) => m.role === 'user')?.content ?? '').slice(0, 80)))}`);
  }
});

await check('images: attach one, the model receives it, the chat shows a thumbnail', async () => {
  // A 1×1 PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  await page.locator('.ag-input').locator('xpath=..').locator('input[type=file]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await page.locator('.cp-chip', { hasText: 'dot.png' }).waitFor();
  const sent = await send('what colour is this image');
  const parts = sent.flatMap((r) => r.messages).filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content);
  const image = parts.find((p) => p.type === 'image_url');
  if (!image?.image_url.url.startsWith('data:image/png;base64,iVBOR')) throw new Error(`no image sent: ${JSON.stringify(parts).slice(0, 300)}`);
  await page.locator('.ag-msg.user img.ag-thumb').last().waitFor({ timeout: 5000 });
  return 'image_url part sent; thumbnail shown';
});

await check('permission rules: a deny rule added in Settings blocks part of a command line', async () => {
  await page.evaluate(() => bbx.fs.writeFile('/home/user/keep/a.txt', 'keep me'));
  await page.evaluate(() => bbx.openApp('settings', { section: 'permissions' }));
  await page.getByRole('button', { name: 'Add rule' }).click();
  const rule = page.locator('.st-rule').last();
  await rule.getByLabel('Action').selectOption('deny');
  await rule.getByLabel('Pattern').fill('rm -rf *');
  await rule.getByLabel('Pattern').press('Tab');
  await page.waitForFunction(() => JSON.stringify(bbx.settings.get('perms.rules', [])).includes('rm -rf *'));
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.waitForSelector('.sm-overlay', { state: 'detached' });
  const sent = await send('run the risky command', 'Tool said:');
  const result = sent.flatMap((r) => r.messages).findLast((m) => m.role === 'tool')?.content ?? '';
  if (!result.includes('Blocked by the user') || !result.includes('rm -rf *')) throw new Error(`not blocked: ${result}`);
  if ((await page.evaluate(() => bbx.fs.readText('/home/user/keep/a.txt')).catch(() => null)) !== 'keep me') throw new Error('the file was deleted');
  await page.evaluate(() => bbx.settings.set('perms.rules', []));
  return result.slice(0, 80);
});

await check('chats keep working in the background, shown in the sidebar', async () => {
  try {
  const input = page.locator('.ag-input');
  await input.fill('another slow task');
  await input.press('Enter');
  await page.waitForSelector('.cp-send.stop:not([hidden])');
  // Switch to a new chat while the first is still working.
  await page.locator('.bb-more').click();
  await page.locator('.menu .pop-item', { hasText: 'New chat' }).click();
  await page.waitForSelector('.bb.is-empty');
  // The sidebar marks the working chat (opened as a drawer on narrow screens; here it is visible).
  await page.waitForSelector('.sb-live.running', { timeout: 10000 });
  await send('quick question meanwhile', 'echo: quick question meanwhile');
  // The background chat finishes on its own and is saved.
  await page.waitForFunction(() => !document.querySelector('.sb-live'), null, { timeout: 20000 });
  const saved = await page.evaluate(async () => {
    const files = await bbx.fs.readdir('/home/agent/.sessions');
    // Chat files only (a chat's attachments are in a folder of its own beside them).
    for (const f of files.filter((x) => x.kind === 'file' && x.name.endsWith('.json') && x.name !== 'index.json')) {
      const s = JSON.parse(await bbx.fs.readText(f.path));
      if (JSON.stringify(s.transcript).includes('echo: another slow task')) return true;
    }
    return false;
  });
  if (!saved) throw new Error('the background chat did not finish and save');
  return 'background chat finished and saved while another chat was used';
  } catch (err) {
    throw new Error(`${err.message.split('\n')[0]} · ${await dump()} · last requests: ${JSON.stringify(requests.slice(-3).map((r) => (r.messages.findLast((m) => m.role === 'user')?.content ?? '').slice(0, 80)))}`);
  }
});

await check('accounts, gh without a token, and a production build', async () => {
  await page.evaluate(() => bbx.openApp('settings', { section: 'accounts' }));
  const panel = page.locator('.sm-dialog [data-app="settings"]');
  await panel.locator('h3', { hasText: 'GitHub' }).waitFor();
  const gh = panel.locator('.st-panel', { hasText: 'GitHub' });
  await gh.locator('input[type="password"]').fill('github_pat_test');
  await gh.locator('button', { hasText: /Save/ }).click();
  await page.waitForFunction(() => bbx.secrets.has('github.token'));
  await page.locator('.sm-head [aria-label="Close settings"]').click();
  await page.evaluate(() => bbx.secrets.delete('github.token'));
  await page.evaluate(() => bbx.openApp('terminal'));
  await page.waitForSelector('.term-input');
  const out = await term('gh push /home/agent/todo; echo GH-DONE', '\nGH-DONE', 30000);
  if (!/No GitHub token yet[\s\S]*Settings → Accounts/.test(out)) throw new Error(out.slice(-400));
  const built = await term('build /home/agent/todo --out /home/agent/todo-dist && echo BUILD-DONE', '\nBUILD-DONE', 120000);
  const html = await page.evaluate(() => bbx.fs.readText('/home/agent/todo-dist/index.html'));
  if (html.includes('__bbxDev') || !html.includes('<script type="module">')) throw new Error(`not a production page: ${html.slice(0, 200)}`);
  return `token saved and removed; gh explains; ${built.match(/built \d+ files \([^)]*\)/)?.[0]}`;
});

await check('help: docs open from the menu, links between topics work, search finds text; /docs/ page deep-links', async () => {
  await page.locator('.bb-more').first().click();
  await page.getByRole('menuitem', { name: 'Help & docs' }).click();
  const pane = page.locator('.wb-pane[data-app="help"]:not([hidden])');
  // A narrow panel lists the topics first, like a phone.
  await pane.locator('.dc-link').first().waitFor();
  const topics = await pane.locator('.dc-link').count();
  if (!(await pane.locator('.dc-article h1').isVisible())) await pane.locator('.dc-link', { hasText: 'About BrowserBox' }).click();
  await pane.locator('.dc-article h1').waitFor();
  await pane.locator('.dc-article a', { hasText: /deploy|shipping/i }).first().click();
  await pane.locator('.dc-article h1', { hasText: /ship/i }).waitFor({ timeout: 5000 });
  if (await pane.locator('.dc-back').isVisible()) await pane.locator('.dc-back').click();
  await pane.locator('.dc-search').fill('netlify');
  const hits = await pane.locator('.dc-hit').count();
  if (!hits) throw new Error('search found nothing for netlify');
  const p = await context.newPage();
  await p.goto(base + 'docs/#models');
  const title = await p.locator('.dc-article h1').textContent();
  if (!/model/i.test(title)) throw new Error(`deep link opened ${title}`);
  await p.locator('.dc-link', { hasText: 'Terminal' }).first().click();
  const hash = await p.evaluate(() => location.hash);
  await p.close();
  return `${topics} topics; topic links work; ${hits} search hit(s); /docs/#models deep-links, hash follows (${hash})`;
});

if (errors.length) {
  failed++;
  console.log('page errors:\n  ' + errors.join('\n  '));
}
await check('accept-edits mode via Shift+Tab; a sub-agent card opens what it did', async () => {
  const mode = await page.evaluate(() => bbx.perms.mode);
  try {
    await page.evaluate(() => (bbx.perms.mode = 'ask'));
    const input = page.locator('.ag-input');
    await input.focus();
    await input.press('Shift+Tab');
    await page.locator('.cp-mode', { hasText: 'Accept edits' }).waitFor({ timeout: 5000 });
    if ((await page.evaluate(() => bbx.perms.mode)) !== 'edits') throw new Error('the mode was not stored as edits');
    await page.evaluate(() => (bbx.perms.mode = 'auto'));
    await send('delegate to explorer', 'Tool said');
    const card = page.locator('.ag-tool', { hasText: 'spawn_agent' }).last();
    await card.locator('summary').click();
    await card.getByRole('button', { name: 'Show what it did' }).click();
    const dialog = page.locator('.ag-sub-modal');
    await dialog.locator('text=EXPLORER REPORT').waitFor({ timeout: 10000 });
    await dialog.getByRole('button', { name: 'Close' }).click();
    return 'Shift+Tab → Accept edits (stored as edits); the explorer’s transcript opened from its card';
  } finally {
    await page.evaluate((m) => (bbx.perms.mode = m), mode);
  }
});

await check('hooks: one added in Settings runs after an edit; the agent sees its output', async () => {
  const mode = await page.evaluate(() => bbx.perms.mode);
  try {
    await page.evaluate(() => (bbx.perms.mode = 'auto'));
    await page.evaluate(() => bbx.fs.writeFile('/home/agent/notes.txt', 'first\nsecond\nthird\n'));
    await page.evaluate(() => bbx.openApp('settings', { section: 'hooks' }));
    await page.getByRole('button', { name: 'Add hook' }).click();
    const hk = page.locator('.st-hook').last();
    await hk.getByLabel('Tools').fill('write_file');
    await hk.getByLabel('Command').fill('echo checked $BBX_FILE');
    await hk.getByLabel('Command').press('Tab');
    await page.waitForFunction(() => JSON.stringify(bbx.settings.get('agent.hooks', [])).includes('checked'));
    await page.getByRole('button', { name: 'Close settings' }).click();
    const sent = await send('please change the notes once more', 'Tool said');
    const result = sent.flatMap((r) => r.messages).filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
    if (!result.includes('[hook output]\nchecked /home/agent/notes.txt')) throw new Error(`no hook output for the model: ${result.slice(-300)}`);
    await page.locator('.ag-hook', { hasText: 'PostToolUse' }).last().waitFor({ timeout: 5000 });
    return 'PostToolUse hook ran on write_file; its output reached the model and the chat shows the run';
  } finally {
    await page.evaluate((m) => ((bbx.perms.mode = m), bbx.settings.set('agent.hooks', [])), mode);
  }
});

await check('projects: make one from the sidebar, the agent works in its folder, /remember, and General keeps its chats', async () => {
  const mode = await page.evaluate(() => bbx.perms.mode);
  try {
    await page.evaluate(() => (bbx.perms.mode = 'auto'));
    const generalChats = await page.locator('.sb-chat').count();
    await page.locator('.sb-project').click();
    await page.locator('.menu .pop-item', { hasText: 'New project' }).click();
    const dlg = page.locator('.pj-modal');
    await dlg.locator('input').first().fill('Demo Site');
    const folder = await dlg.locator('input.mono').inputValue();
    if (folder !== '/home/user/Projects/Demo Site') throw new Error(`default folder ${folder}`);
    await dlg.locator('textarea').fill('Use semantic HTML.');
    await dlg.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.sb-project', { hasText: 'Demo Site' }).waitFor();
    if (await page.locator('.sb-chat').count()) throw new Error('the new project shows other chats');
    const sent = await send('where are you working', 'Tool said');
    const req = sent[0];
    if (!req.messages[0].content.includes('Use semantic HTML.')) throw new Error('AGENTS.md from the project folder is not in the prompt');
    const pwd = sent.flatMap((r) => r.messages).findLast((m) => m.role === 'tool')?.content ?? '';
    if (!pwd.includes('/home/user/Projects/Demo Site')) throw new Error(`pwd ${pwd}`);
    const input = page.locator('.ag-input');
    await input.fill('/remember The site deploys to Netlify');
    await input.press('Enter');
    await page.waitForFunction(async () => ((await bbx.fs.readText('/home/agent/.memory/demo-site.md').catch(() => '')) || '').includes('deploys to Netlify'));
    await page.locator('.sb-project').click();
    await page.locator('.menu .pop-item', { hasText: 'General' }).click();
    await page.locator('.sb-project', { hasText: 'General' }).waitFor();
    await page.waitForFunction((n) => document.querySelectorAll('.sb-chat').length >= n, generalChats);
    return `project folder /home/user/Projects/Demo Site; AGENTS.md read; pwd there; /remember saved; General shows its ${generalChats} chats`;
  } finally {
    await page.evaluate((m) => (bbx.perms.mode = m), mode);
  }
});

await check('artifacts: a card opens the table, sorting works, and an edit makes version 2', async () => {
  const mode = await page.evaluate(() => bbx.perms.mode);
  try {
    await page.evaluate(() => (bbx.perms.mode = 'auto'));
    await page.locator('.bb-more').click();
    await page.locator('.menu .pop-item', { hasText: 'New chat' }).click();
    await send('make a sales table', 'Tool said');
    await page.locator('.ag-artifact', { hasText: 'Sales by region' }).click();
    const firstCell = () => page.locator('.af-table tbody tr').first().locator('td').first().textContent();
    await page.locator('.af-table').waitFor({ timeout: 10000 });
    await page.locator('.af-sort', { hasText: 'amount' }).click();
    if ((await firstCell()) !== 'North') throw new Error(`ascending: ${await firstCell()}`);
    await page.locator('.af-sort', { hasText: 'amount' }).click();
    if ((await firstCell()) !== 'East') throw new Error(`descending: ${await firstCell()}`);
    await send('write the report', 'Tool said');
    await send('improve the report', 'Tool said');
    await page.locator('.ag-artifact', { hasText: 'version 2' }).click();
    await page.locator('.af-doc :is(h1, h2)', { hasText: 'Weekly report' }).waitFor({ timeout: 10000 }).catch(async (e) => {
      const seen = await page.evaluate(() => ({ bar: document.querySelector('.af-bar')?.textContent, body: document.querySelector('.af-body')?.innerHTML.slice(0, 300), cards: [...document.querySelectorAll('.ag-artifact')].map((c) => c.textContent) }));
      throw new Error(`${e.message.split('\n')[0]} · ${JSON.stringify(seen)}`);
    });
    await page.locator('.af-doc', { hasText: 'shipped 3 features' }).waitFor();
    const versions = await page.locator('.af-bar select[aria-label="Version"] option').count();
    if (versions !== 2) throw new Error(`${versions} versions`);
    return 'csv card → sortable table; markdown v1 → edit → v2 rendered with both versions listed';
  } finally {
    await page.evaluate((m) => (bbx.perms.mode = m), mode);
  }
});

await check('scheduled tasks: /schedule prefills one, Run now runs it as a chat, and its outcome is recorded', async () => {
  const input = page.locator('.ag-input');
  await input.fill('/schedule say scheduled ping');
  await input.press('Enter');
  const dlg = page.locator('.pj-modal', { hasText: 'New scheduled task' });
  await dlg.waitFor();
  if ((await dlg.getByLabel('Prompt').inputValue()) !== 'say scheduled ping') throw new Error('the prompt was not prefilled');
  await dlg.getByLabel('Name').fill('Ping');
  await dlg.getByRole('button', { name: 'Create' }).click();
  const item = page.locator('.st-sched-item', { hasText: 'Ping' });
  await item.waitFor();
  await item.getByRole('button', { name: 'Run now' }).click();
  await page.waitForFunction(() => (bbx.settings.get('agent.schedules', [])[0] ?? {}).lastRun?.outcome === 'ok', null, { timeout: 45000 }).catch(async () => {
    throw new Error(`no run recorded: ${JSON.stringify(await page.evaluate(() => bbx.settings.get('agent.schedules', [])))}`);
  });
  const note = await page.evaluate(() => bbx.settings.get('agent.schedules', [])[0].lastRun.note);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.locator('.sb-chat-title', { hasText: '⏱ Ping' }).first().waitFor({ timeout: 10000 });
  await page.evaluate(() => bbx.settings.set('agent.schedules', []));
  return `ran as a chat "⏱ Ping …"; recorded: ${note.slice(0, 60)}`;
});

await check('WASI programs read and write the working folder (files, folders, rename, delete, env)', async () => {
  const wasm = readFileSync(new URL('./fixtures/wasi-files.wasm', import.meta.url)).toString('base64');
  const r = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await bbx.fs.writeFile('/home/user/wt/prog.wasm', bytes);
    await bbx.fs.writeFile('/home/user/wt/input.txt', 'a\nb\nc\n');
    await bbx.fs.writeFile('/home/user/wt/delete-me.txt', 'x');
    const sh = await bbx.shells.open({ cwd: '/home/user/wt' });
    let out = '';
    const code = await sh.run('wasm prog.wasm input.txt', { out: (t) => (out += t), err: (t) => (out += t) });
    sh.close();
    return { code, out, ls: (await bbx.fs.readdir('/home/user/wt')).map((e) => e.name).sort().join(','), report: await bbx.fs.readText('/home/user/wt/out/deep/report.txt').catch((e) => 'ERR ' + e.message) };
  }, wasm);
  if (r.code !== 0 || r.report !== 'input.txt has 3 lines\n' || r.ls !== 'input.txt,out,prog.wasm,renamed.txt' || !r.out.includes('PWD=/home/user/wt') || !r.out.includes('escape: true')) throw new Error(JSON.stringify(r));
  return 'read, mkdir -p, write, rename, delete, list, stat, env, absolute path; escaping refused';
});

await check('Python sees only the folder it runs in, run after run, and its deletes are kept', async () => {
  const r = await page.evaluate(async () => {
    await bbx.fs.writeFile('/home/user/pa/one.txt', '1');
    await bbx.fs.writeFile('/home/user/pb/two.txt', '2');
    await bbx.fs.writeFile('/home/user/pb/gone.txt', 'x');
    const run = async (cwd, code) => {
      const sh = await bbx.shells.open({ cwd });
      let out = '';
      await bbx.fs.writeFile('/tmp/t.py', code);
      await sh.run('python /tmp/t.py', { out: (s) => (out += s), err: (s) => (out += s) });
      sh.close();
      return out.trim();
    };
    const a = await run('/home/user/pa', 'import os; print(sorted(os.listdir(".")))');
    const b = await run('/home/user/pb', 'import os; os.remove("gone.txt"); print(sorted(os.listdir(".")))');
    return { a, b, gone: await bbx.fs.exists('/home/user/pb/gone.txt'), two: await bbx.fs.exists('/home/user/pb/two.txt') };
  });
  if (r.a !== "['one.txt']" || r.b !== "['two.txt']" || r.gone || !r.two) throw new Error(JSON.stringify(r));
  return `${r.a} then ${r.b}; the deleted file is gone`;
});

await check('packages: add a source, install with a dependency, run WASM and JS packages, checks and refusals', async () => {
  await page.evaluate(() => bbx.openApp('terminal'));
  await page.waitForSelector('.term-input');
  // A question is asked in the prompt; an answer shows in the output.
  const typed = async (cmd, waitFor) => {
    const input = page.locator('.term-input').last();
    await input.fill(cmd);
    await input.press('Enter');
    await page.waitForFunction((t) => [...document.querySelectorAll('.term-out')].at(-1)?.textContent.includes(t) || [...document.querySelectorAll('.term-prompt')].at(-1)?.textContent.includes(t), waitFor, { timeout: 30000 }).catch(async (e) => {
      throw new Error(`"${cmd}" did not print "${waitFor}": ${JSON.stringify((await page.locator('.term-out').last().textContent()).slice(-300))}`);
    });
    // Then wait until the terminal takes input again (the command finished, or a question waits).
    await page.waitForFunction(() => {
      const line = [...document.querySelectorAll('.term-line')].at(-1);
      return line && !line.classList.contains('busy');
    }, null, { timeout: 30000 });
  };
  await typed('pkg source add http://localhost:11436/pkg/index.json', 'as a package source?');
  await typed('y', 'packages from it');
  await typed('pkg install wtest', 'Install it?');
  await typed('y', 'installed jshello, wtest');
  await typed('jshello there', 'hello there');
  await typed('pkg remove jshello', 'Remove it first, or use --force');
  await typed('pkg verify', 'every file matches its sha256');
  await typed('pkg install badsum', 'Install it?');
  await typed('y', 'does not match its sha256');
  // The WASM package works on the working folder's files.
  const run = await page.evaluate(async () => {
    await bbx.fs.writeFile('/home/user/pt/input.txt', 'x\ny\n');
    await bbx.fs.writeFile('/home/user/pt/delete-me.txt', 'x');
    // A shell no window answers for: the agent's situation.
    const sh = await bbx.shells.open({ cwd: '/home/user/pt' });
    let out = '';
    const code = await sh.run('wtest input.txt', { out: (t) => (out += t), err: (t) => (out += t) });
    let refused = '';
    await sh.run('pkg install badsum', { out: () => undefined, err: (t) => (refused += t) });
    await bbx.fs.writeFile('/home/user/.local/bin/greet.js', "print('hi from my own command');");
    let mine = '';
    await sh.run('greet', { out: (t) => (mine += t), err: (t) => (mine += t) });
    const done = await sh.complete('pkg ins');
    const ids = await sh.complete('pkg remove js');
    sh.close();
    return { code, report: await bbx.fs.readText('/home/user/pt/out/deep/report.txt').catch(() => ''), refused, mine, done: done.options, ids: ids.options };
  });
  if (run.code !== 0 || run.report !== 'input.txt has 2 lines\n') throw new Error(`wasm package: ${JSON.stringify(run)}`);
  if (!run.refused.includes('only a person can install it')) throw new Error(`not refused: ${run.refused}`);
  if (!run.mine.includes('hi from my own command')) throw new Error(`~/.local/bin: ${run.mine}`);
  if (!run.done.includes('install ') || !run.ids.includes('jshello ')) throw new Error(`completion: ${JSON.stringify(run)}`);
  await page.keyboard.press('Escape');
  return 'source added (asked); wtest + its dependency jshello installed (asked); JS and WASM commands run; dependency kept; verify ok; bad sha256 refused; a program-run install refused; ~/.local/bin; Tab completion';
});

await check('profile commands: a person can switch and exit in the terminal; the agent cannot change profiles', async () => {
  // Auto mode: no approval prompt, so only the profile rule itself can stop the agent.
  const mode = await page.evaluate(() => bbx.perms.mode);
  await page.evaluate(() => (bbx.perms.mode = 'auto'));
  const sent = await send('make yourself a profile', 'Tool said:').finally(() => page.evaluate((m) => (bbx.perms.mode = m), mode));
  const refused = sent.flatMap((r) => r.messages).findLast((m) => m.role === 'tool')?.content ?? '';
  if (!refused.includes('must be typed by a person')) throw new Error(`the agent was not refused: ${refused}`);

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const p = await ctx.newPage();
  const setup = async () => {
    for (const a of ['', '', '']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
  };
  const type = async (cmd, waitFor) => {
    const input = p.locator('.term-input').last();
    await input.fill(cmd);
    await input.press('Enter');
    if (waitFor)
      await p.waitForFunction((t) => [...document.querySelectorAll('.term-out')].at(-1)?.textContent.includes(t), waitFor, { timeout: 30000 }).catch(async () => {
        throw new Error(`"${cmd}" did not print "${waitFor}": ${JSON.stringify((await p.locator('.term-out').last().textContent().catch(() => '')).slice(-200))}`);
      });
  };
  try {
    await p.goto(base + 'agent/');
    await setup();
    await p.evaluate(() => bbx.openApp('terminal'));
    await p.waitForSelector('.term-input');
    await type('profile', 'no password');
    await type('profile new Ana', 'Created Ana');
    await Promise.all([p.waitForEvent('load'), type('profile switch Ana')]);
    await setup();
    await p.evaluate(() => bbx.openApp('terminal'));
    await p.waitForSelector('.term-input');
    await type('profile', 'Ana');
    const prompt = await p.locator('.term-out').last().textContent();
    if (!prompt.includes('ana@bbx')) throw new Error(`prompt: ${prompt.slice(-80)}`);
    await type('exit');
    await p.waitForSelector('.term-input', { state: 'detached', timeout: 10000 });
    return 'agent refused; profile new, switch (window reopened as Ana, prompt ana@bbx) and exit (terminal closed) work';
  } finally {
    await ctx.close();
  }
});

await check('profiles: a second profile is separate; a password locks keys until sign-in', async () => {
  // A context of its own: switching profiles reloads the page.
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const p = await ctx.newPage();
  const setup = async () => {
    for (const a of ['', '', '']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
  };
  try {
    await p.goto(base + 'agent/');
    await setup();
    await p.evaluate(() => bbx.secrets.set('test.key', 'secret-1'));
    await p.evaluate(() => bbx.fs.writeFile('/home/user/first.txt', 'first'));
    await p.evaluate(() => bbx.openApp('settings', { section: 'profile' }));
    await p.getByLabel('New password', { exact: true }).fill('pass1234');
    await p.getByLabel('Repeat the new password').fill('pass1234');
    await p.getByRole('button', { name: 'Set password' }).click();
    await p.getByRole('button', { name: 'Sign out' }).waitFor();
    await p.getByLabel('Name of the new profile').fill('Second');
    await Promise.all([p.waitForEvent('load'), p.getByRole('button', { name: 'New profile' }).click()]);
    await setup();
    const separate = await p.evaluate(async () => !(await bbx.secrets.has('test.key')) && !(await bbx.fs.exists('/home/user/first.txt')));
    if (!separate) throw new Error('the new profile sees the first one’s data');
    await p.locator('.sb-profile').click();
    await p.locator('.menu .pop-item', { hasText: 'Switch profile' }).click();
    await Promise.all([p.waitForEvent('load'), p.locator('.pf-modal .pf-item').first().click()]);
    await p.waitForSelector('.ag-input', { timeout: 60000 });
    await p.locator('.sb-profile').click();
    await Promise.all([p.waitForEvent('load'), p.locator('.menu .pop-item', { hasText: 'Sign out' }).click()]);
    await p.waitForSelector('.pf-signin', { timeout: 60000 });
    await p.getByLabel('Password').fill('wrong');
    await p.getByRole('button', { name: 'Sign in' }).click();
    await p.locator('.st-error', { hasText: 'not right' }).waitFor();
    await p.getByLabel('Password').fill('pass1234');
    await p.getByRole('button', { name: 'Sign in' }).click();
    await p.waitForSelector('.ag-input', { timeout: 60000 });
    if (!(await p.evaluate(() => bbx.secrets.has('test.key')))) throw new Error('the key is gone after signing in');
    // A window opened from here is the same person, still signed in, even though "Second" was used since.
    const [desk] = await Promise.all([ctx.waitForEvent('page'), p.locator('.sb-desktop').click()]);
    await desk.waitForFunction(() => globalThis.bbx?.ready, null, { timeout: 60000 });
    if (!desk.url().includes('profile=default') || (await desk.locator('.pf-signin').count()) || !(await desk.evaluate(() => bbx.secrets.has('test.key')))) throw new Error(`the desktop opened another profile or lost the key: ${desk.url()}`);
    return 'second profile separate; sign-out locked the keys, a wrong password was refused, the keys came back; the desktop opened from here is the same profile, signed in';
  } finally {
    await ctx.close();
  }
});

await check('platform: honest capabilities, notifications while away, a screen picture, passkey sign-in', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, permissions: ['notifications'] });
  // Stand-ins for what a test browser cannot do by itself: being in the background, and picking a screen.
  await ctx.addInitScript(() => {
    globalThis.__away = false;
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => globalThis.__away });
    globalThis.__notes = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title, o = {}) {
        this.title = title;
        this.o = o;
        this.closed = false;
        globalThis.__notes.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    globalThis.Notification = FakeNotification;
    globalThis.__opened = [];
    addEventListener('bbx:open-chat', (e) => globalThis.__opened.push(e.detail));
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = Object.assign(document.createElement('canvas'), { width: 2400, height: 1200 });
        const g = c.getContext('2d');
        g.fillStyle = '#c00';
        g.fillRect(0, 0, 2400, 1200);
        const stream = c.captureStream(5);
        setInterval(() => g.fillRect(0, 0, 10, 10), 100);
        return stream;
      };
    }
  });
  const p = await ctx.newPage();
  const done = [];
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });

    // 1. The capability list says what is used, and only that.
    await p.evaluate(() => bbx.openApp('sysinfo', { section: 'caps' }));
    await p.getByText('Used for: Sharing a picture of a screen with the agent').waitFor({ timeout: 15000 });
    const caps = await p.evaluate(() => bbx.caps.filter((c) => ['webcodecs', 'share', 'capture', 'passkeys', 'notifications'].includes(c.id)).map((c) => `${c.id}:${c.used}`).join(' '));
    if (caps !== 'notifications:true share:true passkeys:true webcodecs:false capture:true') throw new Error(`capabilities: ${caps}`);
    await p.keyboard.press('Escape');
    done.push('capabilities honest');

    // 2. Away from the window: an approval waiting, then the chat finishing, each a notification.
    await p.evaluate(() => (globalThis.__away = true));
    await p.locator('.ag-input').fill('touch while away');
    await p.locator('.ag-input').press('Enter');
    await p.locator('.ag-approval').waitFor({ timeout: 30000 });
    const ask = await p.waitForFunction(() => globalThis.__notes.find((n) => /needs your approval/.test(n.title)) && globalThis.__notes.map((n) => ({ title: n.title, body: n.o.body, sticky: n.o.requireInteraction, closed: n.closed })), null, { timeout: 15000 }).then((h) => h.jsonValue());
    const a = ask.find((n) => /needs your approval/.test(n.title));
    if (!a.sticky || !a.body.includes('touch /home/user/away.txt')) throw new Error(`approval notification: ${JSON.stringify(a)}`);
    // Clicking it brings the chat forward.
    await p.evaluate(() => globalThis.__notes.find((n) => /approval/.test(n.title)).onclick());
    if (!(await p.evaluate(() => globalThis.__opened.length === 1 && typeof globalThis.__opened[0] === 'string'))) throw new Error('the click did not open the chat');
    await p.locator('.ag-approval button', { hasText: 'Allow once' }).click();
    await p.waitForFunction(() => globalThis.__notes.find((n) => /approval/.test(n.title)).closed, null, { timeout: 10000 });
    await p.waitForFunction(() => globalThis.__notes.some((n) => n.title.startsWith('Done:')), null, { timeout: 30000 });
    await p.evaluate(() => (globalThis.__away = false));
    done.push('approval notified (closed once answered, click opens the chat); done notified');

    // 3. One picture of a screen, attached to the message, scaled down.
    await p.locator('.cp-plus').click();
    await p.locator('.menu .pop-item', { hasText: 'Share a screen' }).click();
    await p.locator('.cp-chips:not([hidden])', { hasText: 'screen-' }).waitFor({ timeout: 15000 });
    const shot = await p.evaluate(async () => {
      // Kept with the chat: /home/agent/.sessions/<chat>/files/.
      const found = document.querySelector('.cp-chip[title*="screen-"]').title;
      const bytes = await bbx.fs.readFile(found);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      return { found, png: bytes[1] === 0x50, w: bmp.width, h: bmp.height };
    });
    if (!shot.png || shot.w !== 1920 || shot.h !== 960) throw new Error(`screen picture: ${JSON.stringify(shot)}`);
    done.push(`screen ${shot.w}×${shot.h} attached`);

    // 4. A passkey (a virtual authenticator with PRF) signs in instead of the password.
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    await p.evaluate(() => bbx.secrets.set('test.key', 'pk-secret'));
    await p.evaluate(() => bbx.openApp('settings', { section: 'profile' }));
    await p.getByLabel('New password', { exact: true }).fill('pass1234');
    await p.getByLabel('Repeat the new password').fill('pass1234');
    await p.getByRole('button', { name: 'Set password' }).click();
    await p.getByRole('button', { name: 'Add a passkey' }).waitFor();
    await p.getByLabel('Name for the passkey').fill('Test key');
    await p.getByLabel('Your password').fill('pass1234');
    await p.getByRole('button', { name: 'Add a passkey' }).click();
    await p.getByText(/Test key · added/).waitFor({ timeout: 15000 });
    await Promise.all([p.waitForEvent('load'), p.evaluate(() => bbx.secrets.lock().then(() => location.reload()))]);
    await p.waitForSelector('.pf-signin', { timeout: 60000 });
    await p.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await p.waitForSelector('.ag-input', { timeout: 60000 });
    if (!(await p.evaluate(() => bbx.secrets.has('test.key')))) throw new Error('the key is gone after the passkey sign-in');
    if ((await p.evaluate(() => bbx.secrets.status())) !== 'unlocked') throw new Error('not signed in');
    done.push('passkey added, signed out, signed in with it');
    return done.join('; ');
  } catch (err) {
    throw new Error(`${done.join('; ')} | ${err.message}`);
  } finally {
    await ctx.close();
  }
});

await check('built-in model: the agent in its worker uses the page’s Prompt API, with text tool calls', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  // Test browsers have no on-device model: this one plays it, in the page only (not in workers).
  await ctx.addInitScript(() => {
    if (typeof document === 'undefined') return;
    globalThis.__lm = [];
    globalThis.LanguageModel = {
      availability: async () => 'available',
      create: async (o) => ({
        destroy() {},
        promptStreaming(input) {
          globalThis.__lm.push({ system: o.initialPrompts[0].content.slice(0, 60), turns: o.initialPrompts.length, input: input.slice(0, 200) });
          const reply = input.includes('<tool_result>') ? `The command printed ${/builtin-\w+/.exec(input)?.[0]}.` : '<tool_call>{"name": "shell", "arguments": {"command": "echo builtin-ok"}}</tool_call>';
          // Written slowly, as a real model does, so streaming can be seen.
          return (async function* () {
            for (const part of reply.match(/.{1,6}/gs)) {
              await new Promise((r) => setTimeout(r, 120));
              yield part;
            }
          })();
        },
      }),
    };
  });
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    await p.evaluate(() => {
      bbx.perms.mode = 'auto';
      bbx.settings.set('agent.config', { ...bbx.settings.get('agent.config', {}), provider: 'builtin' });
    });
    await p.locator('.cp-model').click();
    const picked = await p.locator('.menu .pop-item', { hasText: 'Built-in model' }).count();
    await p.keyboard.press('Escape');
    await p.locator('.ag-input').fill('list files please');
    await p.locator('.ag-input').press('Enter');
    // Streamed: part of the answer is on screen before the rest has been written.
    const partial = await p.waitForFunction(() => {
      const t = document.querySelector('.ag-log')?.textContent ?? '';
      return t.includes('The comm') && !t.includes('builtin-ok.') && t.slice(t.lastIndexOf('The comm'), t.lastIndexOf('The comm') + 40);
    }, null, { timeout: 60000, polling: 30 }).then((h) => h.jsonValue());
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('The command printed builtin-ok.'), null, { timeout: 60000 });
    // The tool call itself was never shown as text.
    if (await p.evaluate(() => document.querySelector('.ag-log').textContent.includes('<tool_call>'))) throw new Error('the tool call markup was shown');
    const calls = await p.evaluate(() => globalThis.__lm);
    if (calls.length !== 2 || !calls[0].input.includes('list files please') || !calls[1].input.includes('<tool_result>')) throw new Error(JSON.stringify(calls));
    if (!picked) throw new Error('the model menu does not offer the built-in model');
    return `streamed ("${partial.trim()}" first); 2 prompts (system + ${calls[1].turns - 1} turns of history the second time); the tool ran; the menu offers it`;
  } finally {
    await ctx.close();
  }
});

await check('Settings → Packages: lists the BrowserBox index, adds a source, installs with a dependency, removes, verifies', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  const steps = [];
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    await p.evaluate(() => bbx.openApp('settings', { section: 'packages' }));
    const item = (title) => p.locator('.st-sched-item', { has: p.locator('strong', { hasText: new RegExp(`^${title}\\b`) }) });
    await item('quickjs').waitFor({ timeout: 20000 });
    if (!(await item('quickjs').textContent()).includes('BrowserBox index')) throw new Error('the official index is not labelled');
    await item('python').waitFor();
    steps.push('official index and built-in packages listed');

    await p.getByLabel('Index URL').fill('http://localhost:11436/pkg/index.json');
    await p.getByRole('button', { name: 'Add source' }).click();
    await p.locator('[role=alertdialog]').getByRole('button', { name: 'Add source' }).click();
    await item('wtest').waitFor({ timeout: 20000 });
    steps.push('source added (asked)');

    await item('wtest').getByRole('button', { name: 'Install' }).click();
    await p.locator('[role=alertdialog]', { hasText: 'not the BrowserBox index' }).getByRole('button', { name: 'Install' }).click();
    await p.locator('.st-note', { hasText: 'Installed wtest.' }).waitFor({ timeout: 30000 });
    await item('jshello').locator('.badge', { hasText: 'Installed 1.2.0' }).waitFor({ timeout: 10000 });
    steps.push('wtest installed with jshello (asked)');

    await item('jshello').getByRole('button', { name: 'Remove' }).click();
    await p.locator('[role=alertdialog]', { hasText: 'wtest needs it' }).getByRole('button', { name: 'Cancel' }).click();
    await item('wtest').getByRole('button', { name: 'Remove' }).click();
    await p.locator('.st-note', { hasText: 'Removed wtest.' }).waitFor({ timeout: 20000 });
    steps.push('dependent warned; wtest removed');

    await p.getByRole('button', { name: 'Verify files' }).click();
    await p.locator('.st-note', { hasText: 'Every installed file matches its checksum.' }).waitFor({ timeout: 20000 });
    const ext = await p.evaluate(() => Object.keys(bbx.settings.get('pkg.external', {})).join(','));
    if (ext !== 'jshello') throw new Error(`installed: ${ext}`);
    steps.push('verified');
    return steps.join('; ');
  } catch (err) {
    throw new Error(`${steps.join('; ')} | ${err.message}`);
  } finally {
    await ctx.close();
  }
});

await check('installed app: shared files and text, opened files, shortcuts, the badge for chats waiting', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.addInitScript(() => {
    if (typeof document === 'undefined') return;
    globalThis.__badges = [];
    Object.defineProperty(Navigator.prototype, 'setAppBadge', { configurable: true, value: async (n) => void globalThis.__badges.push(n) });
    Object.defineProperty(Navigator.prototype, 'clearAppBadge', { configurable: true, value: async () => void globalThis.__badges.push(0) });
    Object.defineProperty(globalThis, 'launchQueue', { configurable: true, value: { setConsumer: (fn) => (globalThis.__launch = fn) } });
  });
  const p = await ctx.newPage();
  const steps = [];
  const boot = async () => {
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
  };
  try {
    await p.goto(base + 'agent/');
    await boot();
    // The service worker must control the page for the share target.
    await p.evaluate(() => navigator.serviceWorker.ready);
    if (!(await p.evaluate(() => !!navigator.serviceWorker.controller))) await p.reload(), await p.waitForSelector('.ag-input', { timeout: 120000 });

    // Shared from another app: the service worker keeps it and opens the agent with it.
    const to = await p.evaluate(async () => {
      const form = new FormData();
      form.append('title', 'A note');
      form.append('text', 'please summarise this');
      form.append('files', new File(['shared body'], 'shared-note.txt', { type: 'text/plain' }));
      const res = await fetch('./share-target', { method: 'POST', body: form });
      return res.url;
    });
    if (!/\?shared=[0-9a-f-]{36}$/.test(to)) throw new Error(`share target answered ${to}`);
    await p.goto(to);
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    await p.locator('.cp-chips:not([hidden])', { hasText: 'shared-note.txt' }).waitFor({ timeout: 20000 });
    const typed = await p.locator('.ag-input').inputValue();
    if (!typed.includes('A note') || !typed.includes('please summarise this') || p.url().includes('shared=')) throw new Error(`text ${JSON.stringify(typed)} url ${p.url()}`);
    const kept = await p.evaluate(async () => (await (await caches.open('bbx-share')).keys()).length);
    if (kept) throw new Error('the share was not cleaned up');
    steps.push('shared file and text arrive in the message box');

    // Opened with the installed app (file_handlers → launchQueue).
    await p.evaluate(() => globalThis.__launch({ files: [{ getFile: async () => new File(['a,b\n1,2\n'], 'opened.csv', { type: 'text/csv' }) }] }));
    await p.locator('.cp-chips', { hasText: 'opened.csv' }).waitFor({ timeout: 10000 });
    steps.push('opened file attached');

    // A chat waiting for an approval shows on the icon; answered, the badge clears.
    await p.locator('.ag-input').fill('touch while away');
    await p.locator('.ag-input').press('Enter');
    await p.locator('.ag-approval').waitFor({ timeout: 30000 });
    await p.waitForFunction(() => globalThis.__badges.at(-1) === 1, null, { timeout: 10000 });
    await p.locator('.sb-live.waiting').waitFor({ timeout: 5000 });
    await p.locator('.ag-approval button', { hasText: 'Deny' }).click();
    await p.waitForFunction(() => globalThis.__badges.at(-1) === 0, null, { timeout: 15000 });
    steps.push('badge 1 while waiting, cleared after');

    // Shortcuts: the terminal.
    await p.goto(base + 'agent/?open=terminal');
    await p.locator('.term-input').first().waitFor({ timeout: 60000 });
    steps.push('terminal shortcut');
    const manifest = await p.evaluate(() => fetch('../manifest.webmanifest').then((r) => r.json()));
    if (!manifest.file_handlers?.length || manifest.share_target?.method !== 'POST' || manifest.shortcuts?.length !== 3) throw new Error('manifest');
    return steps.join('; ');
  } catch (err) {
    throw new Error(`${steps.join('; ')} | ${err.message}`);
  } finally {
    await ctx.close();
  }
});

await check('share to other apps, the mini window (with an approval answered there), a voice note with its transcript', async () => {
  // A browser of its own, with a fake microphone.
  const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await b.newContext({ viewport: { width: 1200, height: 850 }, permissions: ['microphone'] });
  await ctx.addInitScript(() => {
    if (typeof document === 'undefined') return;
    globalThis.__shared = [];
    Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: (d) => !!d?.files?.length });
    Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: async (d) => void globalThis.__shared.push({ title: d.title, files: d.files.map((f) => `${f.name}:${f.type}`) }) });
    // The mini window: a popup stands in for the always-on-top one.
    Object.defineProperty(globalThis, 'documentPictureInPicture', { configurable: true, value: { window: null, requestWindow: async () => (globalThis.__pip = window.open('', 'pip', 'width=360,height=420')) } });
    class FakeRecognition {
      start() {
        setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'remind me to water the plants' }], { isFinal: true })] }), 300);
      }
      stop() {
        setTimeout(() => this.onend?.(), 10);
      }
    }
    globalThis.SpeechRecognition = FakeRecognition;
  });
  const p = await ctx.newPage();
  const steps = [];
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });

    // Share a file from Files.
    await p.evaluate(() => bbx.fs.writeFile('/home/agent/report.md', '# Report'));
    await p.evaluate(() => bbx.openApp('files', { path: '/home/agent' }));
    await p.locator('[role=row]', { hasText: 'report.md' }).first().click({ button: 'right' });
    await p.locator('.menu .pop-item, [role=menuitem]', { hasText: 'Share…' }).first().click();
    await p.waitForFunction(() => globalThis.__shared.length === 1, null, { timeout: 10000 });
    const shared = await p.evaluate(() => globalThis.__shared[0]);
    if (shared.files[0] !== 'report.md:text/plain') throw new Error(JSON.stringify(shared));
    await p.keyboard.press('Escape');
    steps.push('file shared');

    // The mini window follows the chat and takes an approval.
    await p.evaluate(() => (bbx.perms.mode = 'ask'));
    await p.locator('.ag-more, [aria-label="More"]').first().click();
    const [pip] = await Promise.all([ctx.waitForEvent('page'), p.locator('.menu .pop-item, [role=menuitem]', { hasText: 'Mini window' }).first().click()]);
    await p.locator('.ag-input').fill('touch while away');
    await p.locator('.ag-input').press('Enter');
    await pip.locator('.card button', { hasText: 'Allow once' }).click({ timeout: 30000 });
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('Tool said:'), null, { timeout: 30000 });
    if (await p.locator('.ag-approval .ag-card-actions button:not([disabled])').count()) throw new Error('the chat still asks after the mini window answered');
    if (!(await p.evaluate(() => bbx.fs.exists('/home/user/away.txt')))) throw new Error('the approved command did not run');
    const pipText = await pip.locator('body').textContent();
    if (!pipText.includes('touch /home/user/away.txt') || !/Done|Working/.test(pipText)) throw new Error(`mini window: ${pipText.slice(0, 300)}`);
    await pip.close();
    steps.push('mini window followed the chat; its approval ran the command');

    // A voice note: an audio file attached, its transcript in the message.
    await p.locator('.cp-plus').click();
    await p.locator('.menu .pop-item', { hasText: 'Record a voice note' }).click();
    await p.locator('.cp-voice').waitFor({ timeout: 10000 });
    await p.waitForTimeout(1500);
    await p.locator('.cp-voice button', { hasText: 'Stop' }).click();
    await p.locator('.cp-chips:not([hidden])', { hasText: /voice-.*\.(webm|ogg|m4a)/ }).waitFor({ timeout: 15000 });
    const text = await p.locator('.ag-input').inputValue();
    if (!text.includes('Voice note (transcript): remind me to water the plants')) throw new Error(`text: ${text}`);
    const size = await p.evaluate(async () => {
      const path = document.querySelector('.cp-chip[title*="voice-"]').title;
      if (!/\/home\/agent\/\.sessions\/[^/]+\/files\/voice-/.test(path)) throw new Error(`attached at ${path}`);
      return (await bbx.fs.readFile(path)).length;
    });
    if (size < 1000) throw new Error(`audio only ${size} bytes`);
    steps.push(`voice note ${size} bytes with transcript`);
    return steps.join('; ');
  } catch (err) {
    throw new Error(`${steps.join('; ')} | ${err.message}`);
  } finally {
    await b.close();
  }
});

await check('devices: a serial device from the terminal, a folder sent to another device, reminders of due tasks', async () => {
  const boot = async (p) => {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
  };
  const run = (p, line) =>
    p.evaluate(async (line) => {
      const sh = await bbx.shells.open({ cwd: '/home/user' });
      let out = '';
      const code = await sh.run(line, { out: (s) => (out += s), err: (s) => (out += s) });
      sh.close();
      return { code, out };
    }, line);
  // Two "devices": separate browser contexts.
  const a = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const b = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await a.addInitScript(() => {
    if (typeof document === 'undefined') return;
    // A serial device that answers each line with "echo: <line>".
    const port = {
      opened: false,
      getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x0043 }),
      async open() {
        let push;
        this.readable = new ReadableStream({ start: (c) => (push = c) });
        this.writable = new WritableStream({ write: (chunk) => push.enqueue(new TextEncoder().encode(`echo: ${new TextDecoder().decode(chunk)}`)) });
      },
      async close() {},
      async forget() {},
      readable: null,
      writable: null,
    };
    const granted = [];
    Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => ({ getPorts: async () => granted, requestPort: async () => (granted.includes(port) || granted.push(port), port) }) });
  });
  const steps = [];
  try {
    const pa = await a.newPage();
    const pb = await b.newPage();
    await Promise.all([boot(pa), boot(pb)]);

    // Serial: connected once in Settings, then used from a shell (through the window).
    await pa.evaluate(() => bbx.openApp('settings', { section: 'devices' }));
    await pa.getByRole('button', { name: 'Connect a device…' }).click();
    await pa.locator('.st-sched-item', { hasText: 'USB 2341:0043' }).waitFor({ timeout: 10000 });
    const list = await run(pa, 'serial list');
    if (!list.out.includes('0  USB 2341:0043')) throw new Error(`serial list: ${list.out}`);
    const sent = await run(pa, 'serial send 0 hello device');
    const got = await run(pa, 'serial read 0 --ms 2000');
    if (sent.code !== 0 || !got.out.includes('echo: hello device')) throw new Error(`serial: ${sent.out} | ${got.out}`);
    steps.push('serial device connected, then send/read from the shell');

    // A folder from device A to device B, through the Settings UI on both.
    await pa.evaluate(async () => {
      await bbx.fs.mkdir('/home/user/proj/src');
      await bbx.fs.writeFile('/home/user/proj/README.md', '# Project');
      await bbx.fs.writeFile('/home/user/proj/src/big.bin', new Uint8Array(300000).map((_, i) => i % 251));
      await bbx.fs.writeFile('/home/user/proj/empty.txt', '');
    });
    await pb.evaluate(() => bbx.openApp('settings', { section: 'devices' }));
    await pa.getByLabel('Folder or file to send').fill('/home/user/proj');
    await pa.getByRole('button', { name: 'Send…' }).click();
    await pa.waitForFunction(() => document.querySelector('textarea[aria-label="Your code"]')?.value.startsWith('BBX1.'), null, { timeout: 15000 });
    const offer = await pa.getByLabel('Your code').inputValue();
    await pb.getByLabel('The other device’s code').fill(offer);
    await pb.getByRole('button', { name: 'Connect', exact: true }).click();
    await pb.waitForFunction(() => document.querySelector('textarea[aria-label="Your code"]')?.value.startsWith('BBX1.'), null, { timeout: 15000 });
    const answer = await pb.getByLabel('Your code').inputValue();
    await pa.getByLabel('The other device’s code').fill(answer);
    await pa.getByRole('button', { name: 'Connect', exact: true }).click();
    await pa.locator('.st-note', { hasText: 'Sent 3 files' }).waitFor({ timeout: 30000 });
    await pb.locator('.st-note', { hasText: 'Received 3 files' }).waitFor({ timeout: 30000 });
    const recv = await pb.evaluate(async () => {
      const big = await bbx.fs.readFile('/home/user/Received/proj/src/big.bin');
      return { readme: await bbx.fs.readText('/home/user/Received/proj/README.md'), big: big.length, ok: big.every((v, i) => v === i % 251), empty: await bbx.fs.exists('/home/user/Received/proj/empty.txt') };
    });
    if (recv.readme !== '# Project' || recv.big !== 300000 || !recv.ok || !recv.empty) throw new Error(`received: ${JSON.stringify(recv)}`);
    steps.push('folder (3 files, 300 KB) sent device to device, byte for byte');

    // Reminders: the summary the service worker reads when the browser wakes it.
    await pa.evaluate(() => bbx.settings.set('agent.schedules', [{ id: 't1', name: 'Morning summary', prompt: 'x', schedule: { every: 'day', at: '08:00' }, allow: { edits: false, commands: false, network: false }, missed: 'run', notify: true, enabled: true, nextRun: Date.now() - 1000 }]));
    const summary = await pa.waitForFunction(async () => {
      const c = await caches.open('bbx-flags');
      for (const k of await c.keys()) if (k.url.includes('/schedules/')) return (await c.match(k)).json();
      return null;
    }, null, { timeout: 10000 }).then((h) => h.jsonValue());
    if (summary.tasks?.[0]?.name !== 'Morning summary') throw new Error(JSON.stringify(summary));
    await pa.evaluate(() => bbx.settings.set('agent.schedules', []));
    steps.push('due-task summary kept for the service worker');
    return steps.join('; ');
  } catch (err) {
    throw new Error(`${steps.join('; ')} | ${err.message}`);
  } finally {
    await a.close();
    await b.close();
  }
});

await check("built-in model on Chromium's native Prompt API: options accepted, too large a prompt gives a clear message", async () => {
  // Chromium ships the API with a stand-in model (it echoes, with a 1000-character window), not Gemini Nano.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', '']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    if ((await p.evaluate(() => typeof LanguageModel)) !== 'function') return 'skipped: this browser has no Prompt API';
    await p.evaluate(() => bbx.settings.set('agent.config', { ...bbx.settings.get('agent.config', {}), provider: 'builtin' }));
    await p.locator('.ag-input').fill('Say hello');
    await p.locator('.ag-input').press('Enter');
    await p.waitForFunction(() => !document.querySelector('.cp-send.stop:not([hidden])'), null, { timeout: 120000 });
    const log = await p.evaluate(() => document.querySelector('.ag-log').innerText);
    if (!log.includes("too long for the browser's built-in model") || /failed:/.test(log)) throw new Error(log.slice(-300));
    return 'session options accepted by the native API; the over-long prompt was retried, then explained';
  } finally {
    await ctx.close();
  }
});

await check('a chat open in two windows: one opened mid-turn shows it working, gets the waiting approval, and can answer it', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const A = await ctx.newPage();
  try {
    await A.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await A.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await A.locator('.boot-console .term-input').fill(a);
      await A.locator('.boot-console .term-input').press('Enter');
    }
    await A.waitForSelector('.ag-input', { timeout: 120000 });
    await A.locator('.ag-input').fill('slow touch while away');
    await A.locator('.ag-input').press('Enter');
    await A.waitForTimeout(800);
    const B = await ctx.newPage();
    await B.goto(base + 'os/');
    await B.waitForFunction(() => globalThis.bbx?.ready, null, { timeout: 60000 });
    const open = async () => {
      await B.getByText('Agent', { exact: true }).first().dblclick();
      await B.waitForFunction(() => document.querySelector('iframe.win-page'), null, { timeout: 15000 });
      const f = await (await B.$('iframe.win-page')).contentFrame();
      await f.waitForSelector('.ag-input', { timeout: 60000 });
      return f;
    };
    let f = await open();
    // Mid-turn: shown working, not idle.
    await f.waitForFunction(() => !!document.querySelector('.cp-send.stop:not([hidden])') && /Working|Waiting|Thinking/.test(document.querySelector('.ag-log')?.innerText ?? ''), null, { timeout: 10000 });
    // The approval reaches the frame, and the desktop shows no second dialog.
    await A.locator('.ag-approval:not(.settled)').waitFor({ timeout: 20000 });
    await f.waitForSelector('.ag-approval:not(.settled)', { timeout: 10000 });
    if (await B.locator('.modal.perm').count()) throw new Error('the desktop shows its own dialog too');
    // Closed and opened again while it waits: the approval is there again.
    await B.locator('.win-close, [aria-label="Close"]').first().click();
    await B.waitForTimeout(500);
    f = await open();
    await f.waitForSelector('.ag-approval:not(.settled)', { timeout: 10000 });
    await f.click('.ag-approval:not(.settled) .btn.primary');
    await A.waitForFunction(() => !document.querySelector('.cp-send.stop:not([hidden])') && !document.querySelector('.ag-approval:not(.settled)'), null, { timeout: 20000 });
    if (!(await A.evaluate(() => bbx.fs.exists('/home/user/away.txt')))) throw new Error('the command approved in the second window did not run');
    return 'working state on opening; approval shown there (no extra desktop dialog), replayed after reopening, answered there';
  } finally {
    await ctx.close();
  }
});

await check('previewed apps get localStorage (kept per app), sessionStorage and cookies, in the sandboxed frame', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', '']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    const game = `<!doctype html><title>Game</title><p id=out></p><script>
    const runs = Number(localStorage.getItem('runs') || 0) + 1;
    localStorage.setItem('runs', runs);
    localStorage.best = Math.max(Number(localStorage.best || 0), runs * 10);
    sessionStorage.setItem('tab', 'x');
    document.cookie = 'theme=dark; path=/';
    out.textContent = 'runs=' + runs + ' best=' + localStorage.best + ' keys=' + Object.keys(localStorage).sort().join(',') + ' cookie=' + document.cookie + ' session=' + sessionStorage.getItem('tab');
    </script>`;
    const shown = async (want) => {
      for (let i = 0; i < 80; i++) {
        const fr = p.frames().find((x) => x.url().includes('preview/frame.html'));
        const t = (fr && (await fr.evaluate(() => document.getElementById('out')?.textContent ?? '').catch(() => ''))) || '';
        if (t.startsWith(want)) return t;
        await p.waitForTimeout(100);
      }
      throw new Error(`the page did not show ${want}`);
    };
    await p.evaluate((g) => bbx.fs.writeFile('/home/agent/storegame/index.html', g), game);
    await p.evaluate(() => bbx.openApp('preview', { path: '/home/agent/storegame/index.html' }));
    const first = await shown('runs=1');
    if (first !== 'runs=1 best=10 keys=best,runs cookie=theme=dark session=x') throw new Error(`first: ${first}`);
    // Saved for this app, and given back when the page loads again (here: the file changes, Preview reloads it).
    await p.waitForFunction(() => bbx.fs.readdir('/home/user/.local/share/browserbox/preview-storage').then((l) => l.some((e) => e.name.includes('storegame')), () => false), null, { timeout: 5000 });
    await p.evaluate((g) => bbx.fs.writeFile('/home/agent/storegame/index.html', `${g}\n`), game);
    const second = await shown('runs=2');
    if (!second.startsWith('runs=2 best=20')) throw new Error(`after reload: ${second}`);
    return `${first} → then ${second.split(' ').slice(0, 2).join(' ')}`;
  } finally {
    await ctx.close();
  }
});

await check('the preview tool: the agent opens its page, types, reads, checks and takes a screenshot', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    await p.evaluate(() => {
      bbx.perms.mode = 'auto';
      return bbx.fs.writeFile(
        '/home/agent/guestbook/index.html',
        `<!doctype html><title>Guestbook</title><h1>Guestbook</h1><form id=f><input id=name aria-label="Your name"><button>Sign</button></form><ul id=list></ul><script>
        f.onsubmit = (e) => { e.preventDefault(); const li = document.createElement('li'); li.textContent = name.value; list.append(li); name.value = ''; console.log('signed'); };
        </script>`,
      );
    });
    const before = requests.length;
    await p.locator('.ag-input').fill('test the guestbook');
    await p.locator('.ag-input').press('Enter');
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('PREVIEW DONE'), null, { timeout: 90000 }).catch(async (e) => { throw new Error(e.message + ' log=' + (await p.evaluate(() => document.querySelector('.ag-log')?.innerText.slice(-700)))); });
    const results = requests.slice(before).flatMap((r) => r.messages).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : ''));
    const all = results.join('\n---\n');
    if (!/\[1\] textbox "Your name"/.test(all)) throw new Error(`open did not list the field: ${all.slice(0, 400)}`);
    if (!all.includes('Ada was here')) throw new Error(`the typed entry was not on the page: ${all.slice(0, 600)}`);
    if (!all.includes('EVAL 1')) throw new Error(`eval: ${all.slice(-400)}`);
    if (!/Screenshot of Guestbook \(1280×800\)/.test(all)) throw new Error(`screenshot: ${all.slice(-300)}`);
    // The screenshot went to the model as an image.
    const sawImage = requests.slice(before).some((r) => JSON.stringify(r.messages).includes('data:image/png;base64'));
    if (!sawImage) throw new Error('the screenshot was not shown to the model');
    return 'opened (fields numbered), typed and submitted, read the new entry, eval → 1, screenshot shown to the model';
  } finally {
    await ctx.close();
  }
});

await check('errors: a dropped or overloaded model is retried by itself; a failed reply has Retry; deleting the open chat clears it', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['Ada', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    // The name entered at first boot greets and names the profile.
    await p.waitForFunction(() => document.querySelector('.bb-greet')?.textContent.includes('Ada') && document.querySelector('.sb-profile')?.textContent.includes('Ada'), null, { timeout: 10000 }).catch(async () => {
      throw new Error(`greeting "${await p.locator('.bb-greet').textContent()}", profile "${await p.locator('.sb-profile').textContent()}"`);
    });
    // Before the model answers, the chat says it is waiting for it, not that it is thinking.
    const statuses = [];
    await p.exposeFunction('seenStatus', (t) => statuses.push(t));
    await p.evaluate(() => new MutationObserver(() => document.querySelectorAll('.ag-status span').forEach((s) => seenStatus(s.textContent))).observe(document.querySelector('.ag-log'), { childList: true, subtree: true }));
    await p.locator('.ag-input').fill('flaky question');
    await p.locator('.ag-input').press('Enter');
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('ANSWERED flaky question'), null, { timeout: 30000 });
    if (!statuses.some((s) => /Trying again in \d s/.test(s))) throw new Error(`no retry shown: ${[...new Set(statuses)].join(' | ')}`);
    if (statuses.some((s) => /Thinking/.test(s))) throw new Error(`said Thinking: ${[...new Set(statuses)].join(' | ')}`);
    if (await p.locator('.bb-spin').count()) throw new Error('a second spinner in the header');
    await p.locator('.ag-input').fill('broken question');
    await p.locator('.ag-input').press('Enter');
    const retry = p.locator('.ag-note.error button', { hasText: 'Retry' });
    await retry.waitFor({ timeout: 20000 });
    await retry.click();
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('ANSWERED broken question'), null, { timeout: 20000 });
    const users = await p.locator('.ag-msg.user').count();
    if (users !== 2) throw new Error(`retry sent a new message: ${users} user messages`);
    // Deleting the chat that is open leaves an empty new chat, and the chat does not come back.
    await p.waitForSelector('.sb-chat .sb-chat-open[aria-current="page"]', { state: 'attached', timeout: 10000 });
    const sid = await p.evaluate(() => [...document.querySelectorAll('.sb-chat')].find((c) => c.querySelector('[aria-current="page"]'))?.querySelector('.sb-chat-del')?.getAttribute('aria-label'));
    await p.evaluate(() => [...document.querySelectorAll('.sb-chat')].find((c) => c.querySelector('[aria-current="page"]')).querySelector('.sb-chat-del').click());
    await p.waitForFunction(() => !document.querySelector('.ag-msg.user'), null, { timeout: 10000 });
    await p.waitForTimeout(1500);
    const left = await p.evaluate(() => bbx.fs.readdir('/home/agent/.sessions').then((l) => l.filter((e) => e.name.endsWith('.json') && e.name !== 'index.json').length));
    if (left !== 0) throw new Error(`the deleted chat is still saved (${left})`);
    return `retried by itself (${[...new Set(statuses.filter((s) => /Trying|Waiting/.test(s)))].slice(0, 3).join(' · ')}); Retry answered without a new message; deleted ${sid?.replace('Delete chat ', '')}: chat cleared, nothing saved`;
  } finally {
    await ctx.close();
  }
});

await check('profile settings: sign out explains what it needs; this profile can be deleted from itself', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const p = await ctx.newPage();
  const setup = async () => {
    for (const a of ['', '', '']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
  };
  try {
    await p.goto(base + 'agent/');
    await setup();
    await p.evaluate(() => bbx.openApp('settings', { section: 'profile' }));
    await p.getByRole('button', { name: 'Sign out' }).click();
    const note = await p.locator('.st-note[role="status"]', { hasText: 'Signing out' }).first().innerText();
    await p.getByLabel('Name of the new profile').fill('Temp');
    await Promise.all([p.waitForEvent('load'), p.getByRole('button', { name: 'New profile' }).click()]);
    await setup();
    await p.evaluate(() => bbx.openApp('settings', { section: 'profile' }));
    await p.getByRole('button', { name: 'Delete this profile…' }).click();
    await Promise.all([p.waitForEvent('load'), p.locator('.modal button', { hasText: 'Delete profile' }).click()]);
    await p.waitForSelector('.ag-input', { timeout: 60000 });
    const url = p.url();
    await p.waitForFunction(() => [...document.querySelectorAll('.toast, .notice, [role="status"]')].some((n) => /Temp was deleted/.test(n.textContent)), null, { timeout: 15000 });
    await p.locator('.sb-profile').click();
    await p.locator('.menu .pop-item', { hasText: 'Switch profile' }).click();
    await p.locator('.pf-modal .pf-item').first().waitFor();
    const names = await p.locator('.pf-modal .pf-item').allInnerTexts();
    if (names.some((n) => n.includes('Temp'))) throw new Error(`still listed: ${names.join(', ')}`);
    return `sign out: "${note.slice(0, 60)}…"; deleted Temp from itself, back in ${new URL(url).searchParams.get('profile')} (${names.length} profile${names.length === 1 ? '' : 's'} left)`;
  } finally {
    await ctx.close();
  }
});

await check('background jobs: the agent starts a command, gets on with it, and reads how it ended', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    await p.evaluate(() => (bbx.perms.mode = 'auto'));
    const t0 = Date.now();
    await p.locator('.ag-input').fill('count in the background');
    await p.locator('.ag-input').press('Enter');
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('JOB DONE'), null, { timeout: 60000 });
    const said = await p.evaluate(() => document.querySelector('.ag-log').innerText.match(/JOB DONE[^\n]*/)[0]);
    if (!/Started job1 \(pid \d+\) running/.test(said) || !said.includes('First output: / start')) throw new Error(`start: ${said}`);
    if (!/job1 \(pid \d+\) ended with exit code 0/.test(said) || !said.includes('finished')) throw new Error(`end: ${said}`);
    return `${said.slice(9, 200)}… (${((Date.now() - t0) / 1000).toFixed(1)} s)`;
  } finally {
    await ctx.close();
  }
});

await check('apps in a tab of their own: an artifact and a page open in new tabs on the same kernel', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    await p.evaluate(() => bbx.fs.writeFile('/home/agent/tabsite/index.html', '<!doctype html><title>Tab site</title><h1 id=h>Hello from a tab</h1>'));
    await p.evaluate(() => bbx.openApp('preview', { path: '/home/agent/tabsite/index.html' }));
    await p.waitForSelector('.wb-pane[data-app="preview"]:not([hidden]) iframe');
    const [tab] = await Promise.all([ctx.waitForEvent('page'), p.locator('.wb-actions button[aria-label="Open this tool in a new tab"]').click()]);
    await tab.waitForLoadState();
    const frame = await (await tab.waitForSelector('iframe.pv-frame', { timeout: 60000 })).contentFrame();
    await frame.waitForSelector('#h');
    const heading = await frame.locator('#h').textContent();
    const url = new URL(tab.url());
    if (url.searchParams.get('app') !== 'preview' || !url.searchParams.get('args')?.includes('tabsite')) throw new Error(`tab address: ${tab.url()}`);
    // The same kernel: a file written in the tab is there in the agent window.
    await tab.evaluate(() => bbx.fs.writeFile('/tmp/from-tab.txt', 'shared'));
    const shared = await p.evaluate(() => bbx.fs.readText('/tmp/from-tab.txt'));
    const closedPane = await p.locator('.wb-pane[data-app="preview"]').count();
    // An artifact: its bar is one slim row, and it opens in a tab of its own.
    await p.locator('.ag-input').fill('make a sales table');
    await p.locator('.ag-input').press('Enter');
    await p.locator('.ag-artifact').click();
    const bar = p.locator('.wb-pane[data-app="artifacts"]:not([hidden]) .af-bar');
    await bar.locator('.af-title').waitFor();
    const barHeight = (await bar.boundingBox()).height;
    if (barHeight > 48) throw new Error(`the artifact bar is ${barHeight}px tall`);
    const [art] = await Promise.all([ctx.waitForEvent('page'), bar.locator('button[aria-label="Open in new tab"]').click()]);
    await art.waitForSelector('.af-table', { timeout: 60000 });
    const rows = await art.locator('.af-table tbody tr').count();
    return `"${heading}" in ${url.pathname}?app=preview; kernel shared (${shared}); the panel's tab closed: ${closedPane === 0}; artifact bar ${Math.round(barHeight)}px, its tab shows the table (${rows} rows)`;
  } finally {
    await ctx.close();
  }
});

await check('interactive replies: a ui block draws cards, figures, a chart, a sortable table, choices and a form, and clicks come back as replies', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    const before = requests.length;
    await p.locator('.ag-input').fill('show me the dashboard');
    await p.locator('.ag-input').press('Enter');
    const block = p.locator('.ui-block').first();
    await block.locator('.ui-table').waitFor({ timeout: 30000 });
    // The agent was told about the components.
    const sys = requests[before].messages[0].content;
    if (!sys.includes('# Interactive replies') || !sys.includes('Chart(kind:')) throw new Error('the prompt does not describe ui blocks');
    const seen = await block.evaluate((b) => ({
      callout: b.querySelector('.ui-callout.ok strong')?.textContent,
      stats: [...b.querySelectorAll('.ui-stat strong')].map((s) => s.textContent),
      bars: b.querySelectorAll('.ui-chart rect').length,
      legend: b.querySelectorAll('.ui-legend span').length,
      rows: b.querySelectorAll('.ui-table tbody tr').length,
      ticks: b.querySelectorAll('.ui-checklist li.done').length,
      buttons: [...b.querySelectorAll('.ui-buttons .btn')].map((x) => x.textContent),
      text: document.querySelector('.ag-log').innerText.includes('Pick a plan when ready.'),
    }));
    if (seen.callout !== 'up' || seen.stats.join() !== '$12.4k,182' || seen.bars !== 6 || seen.legend !== 2 || seen.rows !== 3 || seen.ticks !== 1 || !seen.text) throw new Error(JSON.stringify(seen));
    if (process.env.SHOT) await block.screenshot({ path: process.env.SHOT });
    // Sorting by a column.
    await block.locator('.ui-sort', { hasText: 'Sales' }).click();
    const firstAsc = await block.locator('.ui-table tbody tr td').first().textContent();
    if (firstAsc !== 'North') throw new Error(`sorted: ${firstAsc}`);
    // A choice on its own is a reply.
    await block.locator('.ui-chip', { hasText: 'Pro' }).click();
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('GOT Plan: Pro'), null, { timeout: 20000 });
    // A form sends every field.
    await block.getByLabel('Your name').fill('Ada');
    await block.getByLabel('Team size').selectOption('6-20');
    await block.locator('button', { hasText: 'Send details' }).click();
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('GOT Form “details”'), null, { timeout: 20000 });
    const got = await p.evaluate(() => document.querySelector('.ag-log').innerText.match(/GOT Form[^\n]*/)[0]);
    if (!got.includes('name: Ada') || !got.includes('size: 6-20') || !got.includes('news: no')) throw new Error(got);
    // Reopened, the chat draws its blocks again.
    await p.reload();
    await p.waitForSelector('.ui-block .ui-chart rect', { timeout: 60000 });
    return `callout, 2 stats, ${seen.bars} bars with a legend, sortable table, checklist, buttons (${seen.buttons.join(', ')}); a chip and a form came back as replies (${got.slice(4, 90)}…); drawn again after reload`;
  } finally {
    await ctx.close();
  }
});

await check('updates: a newer version on the site shows a banner, and Update now reloads', async () => {
  const ctx = await browser.newContext();
  const live = await (await fetch(base + 'version.json')).json();
  await ctx.route('**/version.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...live, agent: '9.9.9' }) }));
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    const banner = p.locator('.bbx-update');
    await banner.waitFor({ timeout: 20000 });
    const text = await banner.innerText();
    if (!text.includes(`agent ${live.agent} → 9.9.9`)) throw new Error(text);
    await Promise.all([p.waitForEvent('load', { timeout: 20000 }), banner.locator('button', { hasText: 'Update now' }).click()]);
    await banner.waitFor({ timeout: 20000 });
    await banner.locator('button', { hasText: 'Later' }).click();
    await p.reload();
    await p.waitForSelector('.ag-input', { timeout: 60000 });
    await p.waitForTimeout(5000);
    if (await banner.count()) throw new Error('Later did not keep it quiet for this version');
    return `"${text.replace(/\n/g, ' · ')}"; Update now reloaded; Later keeps it quiet until the next version`;
  } finally {
    await ctx.close();
  }
});

await check('web search for any model: Wikipedia without a key, and a page read through Jina Reader (live)', async () => {
  // Wikimedia limits headless browsers by their name; a person's Chrome is not.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    await p.evaluate(() => (bbx.perms.mode = 'auto'));
    const before = requests.length;
    await p.locator('.ag-input').fill('look it up on the web');
    await p.locator('.ag-input').press('Enter');
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('WEB DONE'), null, { timeout: 90000 });
    const tools = requests[before].tools.map((t) => t.function.name);
    if (!tools.includes('web_search') || !tools.includes('web_fetch')) throw new Error(`tools offered: ${tools.join(', ')}`);
    if (!requests[before].messages[0].content.includes('do not write fetch code for searching')) throw new Error('the prompt does not point to the web tools');
    const said = await p.evaluate(() => document.querySelector('.ag-log').innerText.match(/WEB DONE[^\n]*/)[0]);
    // A live service: Wikipedia sometimes rate-limits this machine. That is theirs, not ours.
    if (said.includes('(HTTP 429)')) return 'skipped: Wikipedia rate-limited this machine (HTTP 429); the tools are covered by unit tests';
    if (!said.includes('Results from Wikipedia for “Riemann hypothesis”') || !said.includes('en.wikipedia.org/wiki/Riemann_hypothesis')) throw new Error(`search: ${said.slice(0, 500)}`);
    if (!/example-domains[^|]*(Example Domains|example\.com)/i.test(said)) throw new Error(`fetch: ${said.slice(-500)}`);
    const via = said.includes('read through Jina Reader') ? 'through Jina Reader' : 'directly';
    return `searched Wikipedia (no key), read iana.org ${via}`;
  } finally {
    await ctx.close();
  }
});

await check('isolated chats: the agent works on a copy; the folder changes when you apply', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(base + 'agent/');
    for (const a of ['', '', 'http://localhost:11436/v1']) {
      await p.waitForSelector('.boot-console .term-line:not(.busy)', { timeout: 60000 });
      await p.locator('.boot-console .term-input').fill(a);
      await p.locator('.boot-console .term-input').press('Enter');
    }
    await p.waitForSelector('.ag-input', { timeout: 120000 });
    await p.evaluate(async () => {
      bbx.perms.mode = 'auto';
      await bbx.fs.writeFile('/home/agent/iso/hello.txt', 'v1\n');
      await bbx.fs.writeFile('/home/agent/iso/gone.txt', 'bye\n');
    });
    await p.locator('.ag-input').fill('/isolate');
    await p.locator('.ag-input').press('Enter');
    await p.waitForFunction(() => [...document.querySelectorAll('.bb-changes')].some((b) => !b.hidden && b.textContent.includes('Working on a copy')), null, { timeout: 10000 });
    await p.locator('.ag-input').fill('isolated edit');
    await p.locator('.ag-input').press('Enter');
    await p.waitForFunction(() => document.querySelector('.ag-log')?.textContent.includes('Tool said'), null, { timeout: 60000 });
    const said = await p.evaluate(() => document.querySelector('.ag-log').innerText.match(/Tool said: (\S+)/)?.[1]);
    if (!said?.startsWith('/work/')) throw new Error(`the shell worked in ${said}`);
    const real = await p.evaluate(async () => [await bbx.fs.readText('/home/agent/iso/hello.txt'), await bbx.fs.exists('/home/agent/iso/gone.txt'), await bbx.fs.exists('/home/agent/iso/added.txt')]);
    if (real.join() !== 'v1\n,true,false') throw new Error(`the folder changed before applying: ${JSON.stringify(real)}`);
    const chip = p.locator('.bb-changes', { hasText: 'to apply' });
    await chip.waitFor({ timeout: 10000 });
    const chipText = await chip.innerText();
    if (!chipText.includes('3 files')) throw new Error(`chip: ${chipText}`);
    await chip.click();
    await p.waitForSelector('.ch-dialog .ch-file');
    const listed = await p.locator('.ch-dialog .ch-file summary').allInnerTexts();
    await p.locator('.ch-dialog button', { hasText: 'Apply all' }).click();
    await p.waitForFunction(() => document.querySelector('.ch-dialog .ch-empty'), null, { timeout: 10000 });
    const after = await p.evaluate(async () => [await bbx.fs.readText('/home/agent/iso/hello.txt'), await bbx.fs.exists('/home/agent/iso/gone.txt'), await bbx.fs.readText('/home/agent/iso/added.txt')]);
    if (after.join() !== 'v2\n,false,new\n') throw new Error(`after apply: ${JSON.stringify(after)}`);
    // After a reload the chat still works on its copy (mounted again), which shows the applied files.
    await p.reload();
    await p.waitForFunction(() => [...document.querySelectorAll('.bb-changes')].some((b) => !b.hidden && b.textContent.includes('Working on a copy')), null, { timeout: 60000 });
    const copy = await p.evaluate((dir) => bbx.fs.readText(`${dir}/iso/hello.txt`), said);
    if (copy !== 'v2\n') throw new Error(`the copy after reload: ${copy}`);
    return `worked in ${said}; folder untouched; review listed ${listed.map((l) => l.split('\n').slice(0, 2).join(' ')).join(', ')}; applied; still a copy after reload`;
  } finally {
    await ctx.close();
  }
});

await browser.close();
await server.close();
llm.close();
mcp.close();
process.exit(failed ? 1 : 0);
