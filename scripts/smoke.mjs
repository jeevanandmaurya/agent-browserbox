// Boots the built OS in headless Chromium and exercises the main paths.
// Usage: npm run build && npm run smoke
import { createRequire } from 'node:module';
// Resolve Playwright from the project or a global install (NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');
import { preview } from 'vite';

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
    console.log(`FAIL ${name}: ${err.message.split('\n')[0]}`);
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

for (const extra of process.argv.slice(2)) await import(new URL(extra, `file://${process.cwd()}/`).href).then((m) => m.default({ page, check }));

await check('every app opens', async () => {
  const ids = await page.evaluate(() => [...document.querySelectorAll('.desk-icon')].length);
  for (let i = 0; i < ids; i++) await page.locator('.desk-icon').nth(i).dblclick({ force: true });
  await page.waitForFunction((n) => document.querySelectorAll('.win-body[data-app]').length >= n, ids, { timeout: 15000 });
  const bad = await page.evaluate(() => [...document.querySelectorAll('.app-error')].map((e) => e.textContent.slice(0, 200)));
  if (bad.length) throw new Error(bad.join(' | '));
  return `${ids} apps`;
});
await page.screenshot({ path: process.env.SHOT ?? 'smoke.png' });
if (errors.length) {
  failed++;
  console.log('page errors:\n  ' + errors.join('\n  '));
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
