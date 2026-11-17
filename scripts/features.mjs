// End-to-end checks for the agent's extension features, driven against a
// scripted OpenAI-compatible model and a real (local) MCP server:
// tool packs with progress, environment variables, skills, custom agents,
// slash commands, context meter and compaction, connectors.
// Usage: npm run build && node scripts/features.mjs
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { preview } from 'vite';
const { chromium } = createRequire(import.meta.url)('playwright');

const server = await preview({ preview: { port: 4521, strictPort: true }, logLevel: 'silent' });
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
  const lastUser = msgs.findLast((m) => m.role === 'user')?.content ?? '';
  const system = msgs[0].content;
  if (lastUser.includes('Your context window is nearly full')) return text('SUMMARY: the user asked about skills and weather; all done.');
  if (last.role === 'tool') return text(`Tool said: ${last.content.slice(0, 200)}`);
  if (lastUser.includes('use the web-page skill')) return call('use_skill', { name: 'web-page' });
  if (lastUser.includes('delegate to explorer')) return call('spawn_agent', { task: 'list the workspace', agent: 'explorer' });
  if (system.includes('Your role: explorer')) return text('EXPLORER REPORT: nothing to see');
  if (lastUser.includes('weather please')) return call('mcp__weather__forecast', { city: 'Pune' });
  return text(`echo: ${lastUser.slice(0, 120)}`);
}
const llm = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const b = await body(req);
  if (req.url.endsWith('/models')) return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock' }] }));
  const r = JSON.parse(b);
  requests.push(r);
  promptTokens = Math.ceil(JSON.stringify(r.messages).length / 4);
  res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).end(sse(respond(r)));
}).listen(11436);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
let failed = 0;
const check = async (name, fn) => {
  try {
    const out = await fn();
    console.log(`ok   ${name}${out === undefined ? '' : ' → ' + (typeof out === 'string' ? out : JSON.stringify(out))}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${JSON.stringify(err.message.slice(0, 500))}`);
  }
};
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
  // local server · URL · first model from the server's list · context window · no prompts · theme · packages
  const answers = ['2', 'http://localhost:11436/v1', '1', '8192', 'n', '', 'python zip'];
  for (const a of answers) {
    await page.waitForSelector('.boot-line:not([hidden])', { timeout: 30000 });
    await page.locator('.boot-input').fill(a);
    await page.locator('.boot-input').press('Enter');
  }
  await page.waitForSelector('.ag-input', { timeout: 120000 });
  const out = await page.evaluate(() => ({ cfg: bbx.settings.get('agent.config', {}), perms: bbx.perms.mode, installed: bbx.settings.get('pkg.installed', []) }));
  if (out.cfg.openaiModel !== 'mock' || out.cfg.contextWindow !== 8192 || out.perms !== 'auto' || out.installed.join() !== 'python,zip') throw new Error(JSON.stringify(out));
  return `model ${out.cfg.openaiModel} @ ${out.cfg.openaiBaseUrl}; installed ${out.installed.join(', ')}`;
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

await check('environment variables reach the shell, JavaScript and Python', async () => {
  await page.evaluate(() => bbx.settings.set('env.vars', { GREETING: 'hello-env' }));
  await page.evaluate(() => bbx.openApp('terminal'));
  await page.locator('.wb-tab', { hasText: 'Terminal' }).first().click();
  // A fresh shell picks up the variable.
  await page.locator('.wb-head [aria-label*="Close Terminal"], .wb-tab:has-text("Terminal") .wb-tab-close').first().click();
  await page.evaluate(() => bbx.openApp('terminal'));
  await page.waitForSelector('.term-input');
  const out = await term('echo sh=$GREETING && js -e "return \'js=\' + env.GREETING" && python -c "import os; print(\'py=\' + os.environ[\'GREETING\'])" && echo env-done', '\nenv-done\n', 180000);
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

if (errors.length) {
  failed++;
  console.log('page errors:\n  ' + errors.join('\n  '));
}
await browser.close();
await server.close();
llm.close();
mcp.close();
process.exit(failed ? 1 : 0);
