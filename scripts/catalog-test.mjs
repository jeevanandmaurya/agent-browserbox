#!/usr/bin/env node
// Installs every package of the official index in the built app (from the real
// upstream URLs) and runs its commands on real files. Needs the network.
//   npm run build && NODE_PATH=$(npm root -g) node scripts/catalog-test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { preview } from 'vite';
const { chromium } = createRequire(import.meta.url)('playwright');

const server = await preview({ configFile: 'apps/browserbox/vite.config.ts', preview: { port: 4532, strictPort: true }, logLevel: 'silent' });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4532/agent/');
await page.waitForFunction(() => globalThis.bbx, null, { timeout: 60000 });

const files = {
  'messy.js': 'const   x = {a:1,b:[1,2,3]}\nfunction f( a,b ){return a+b}\n',
  'messy.css': 'a{color:red;margin:0 auto}\n',
  'notes.md': '# Notes\n\nSome *text* and a [link](https://example.com).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
  'conf.yaml': 'name: demo\nitems:\n  - 1\n  - two\nnested: { ok: true }\n',
  'data.json': '{"name":"demo","list":[1,2],"deep":{"x":null}}',
  'src/a.txt': 'alpha\nneedle here\n',
  'src/b.txt': 'beta\n',
  'hello.js': 'console.log("qjs", [1, 2, 3].map((n) => n * 2).join(","));\n',
};
await page.evaluate(async (files) => {
  for (const [p, t] of Object.entries(files)) {
    const full = `/home/user/cat/${p}`;
    await bbx.fs.mkdir(full.replace(/\/[^/]*$/, ''), { recursive: true }).catch(() => {});
    await bbx.fs.writeFile(full, t);
  }
}, files);

const run = (line, stdin) =>
  page.evaluate(
    async ([line]) => {
      const sh = await bbx.shells.open({ cwd: '/home/user/cat' });
      let out = '';
      const code = await Promise.race([sh.run(line, { out: (s) => (out += s), err: (s) => (out += s) }), new Promise((r) => setTimeout(() => r('TIMEOUT'), 180000))]);
      sh.close();
      return { code, out };
    },
    [line, stdin],
  );
const read = (p) => page.evaluate((p) => bbx.fs.readText(`/home/user/cat/${p}`), p);

let failed = 0;
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)${note ? ` → ${note}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
};
const expect = async (line, test, want = 0) => {
  const r = await run(line);
  if (r.code !== want) throw new Error(`"${line}" exited ${r.code}: ${r.out.slice(-600)}`);
  if (test && !test(r.out)) throw new Error(`"${line}" printed: ${r.out.slice(0, 800)}`);
  return r.out.trim().split('\n')[0].slice(0, 100);
};

const index = JSON.parse(readFileSync('packages/runtime/public/kernel/package-index.json', 'utf8'));
await check('every package installs from the official index (no question asked)', async () => {
  const ids = index.packages.map((p) => p.id);
  const r = await run(`pkg install ${ids.join(' ')}`);
  if (r.code !== 0) throw new Error(r.out.slice(-800));
  return `${ids.join(', ')}`;
});
await check('pkg verify', () => expect('pkg verify', (o) => /ok|verified|match/i.test(o)));
await check('quickjs: qjs runs a file and -e', async () => [await expect('qjs hello.js', (o) => o.includes('qjs 2,4,6')), await expect('qjs -e "console.log(6*7)"', (o) => o.trim() === '42')].join(' | '));
await check('ripgrep: rg searches the folder', () => expect('rg -n needle', (o) => /src\/a\.txt:2:needle here/.test(o)));
await check('ripgrep: no match exits 1', () => expect('rg nothing-like-this', null, 1));
await check('prettier: prints formatted JS', () => expect('prettier messy.js', (o) => o.includes('const x = { a: 1, b: [1, 2, 3] };') && o.includes('function f(a, b) {')));
await check('prettier: --check fails, --write fixes, --check passes', async () => {
  await expect('prettier --check messy.css', (o) => o.includes('messy.css'), 1);
  await expect('prettier --write messy.css');
  const css = await read('messy.css');
  if (!css.includes('  color: red;')) throw new Error(css);
  return expect('prettier --check messy.css', null, 0);
});
await check('prettier: Markdown, YAML and stdin', async () => {
  await expect('prettier notes.md', (o) => o.includes('| a   | b   |'));
  await expect('prettier conf.yaml', (o) => o.includes('nested: { ok: true }'));
  return expect('echo "let  a=1" | prettier --parser babel', (o) => o.trim() === 'let a = 1;');
});
await check('marked: Markdown to HTML, a page with -o', async () => {
  await expect('marked notes.md', (o) => o.includes('<h1>Notes</h1>') && o.includes('<em>text</em>') && o.includes('<table>'));
  await expect('marked notes.md -o notes.html --page');
  const html = await read('notes.html');
  if (!html.includes('<title>Notes</title>')) throw new Error(html.slice(0, 300));
  return expect('cat notes.md | marked', (o) => o.includes('<h1>Notes</h1>'));
});
await check('yaml: yaml2json and json2yaml', async () => {
  await expect('yaml2json conf.yaml', (o) => JSON.parse(o).items[1] === 'two' && JSON.parse(o).nested.ok === true);
  await expect('json2yaml data.json', (o) => o.includes('name: demo') && o.includes('  x: null'));
  return expect('yaml2json --compact conf.yaml', (o) => o.trim().startsWith('{"name":"demo"'));
});
await check('Tab completion offers package commands', async () => {
  const c = await page.evaluate(async () => (await (await bbx.shells.open({})).complete('prett')).options);
  if (!c.includes('prettier')) throw new Error(JSON.stringify(c));
});
await check('pkg remove takes them out again', async () => {
  const ids = index.packages.map((p) => p.id);
  await expect(`pkg remove ${ids.join(' ')}`);
  return expect('qjs -e 1', (o) => /pkg install quickjs/.test(o), 127);
});
if (errors.length) (failed++, console.log(`FAIL page errors: ${errors.join(' | ')}`));
await browser.close();
await server.close();
console.log(failed ? `${failed} failed` : 'catalog test passed');
process.exit(failed ? 1 : 0);
