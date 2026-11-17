import * as esbuildWasm from 'esbuild-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Bus } from '../src/kernel/bus';
import { bundle, setEsbuildLoader } from '../src/kernel/dev/bundle';
import { renderHtml } from '../src/kernel/dev/html';
import { Npm, pinVersion, splitSpecifier } from '../src/kernel/dev/npm';
import type { KernelEvents } from '../src/kernel/types';
import { MemFs } from '../src/kernel/vfs/memfs';
import { Vfs } from '../src/kernel/vfs/vfs';

beforeAll(async () => {
  await esbuildWasm.initialize({});
  setEsbuildLoader(async () => esbuildWasm);
});

// A stand-in for esm.sh: entry modules re-export from absolute paths, as the real one does.
const cdn: Record<string, string> = {
  '/tiny@1.2.0/es2022/tiny.mjs': 'export default function tiny() { return "tiny-ok"; }',
  '/react@18.3.1/es2022/jsx-runtime.mjs': 'export const jsx = (t, p) => ({ t, p }); export const jsxs = jsx; export const Fragment = "frag";',
};
const fetcher = (async (input: string | URL) => {
  const url = new URL(String(input));
  if (url.pathname === '/tiny@1.2.0') return new Response('export { default } from "/tiny@1.2.0/es2022/tiny.mjs";');
  if (url.pathname === '/react@18.3.1/jsx-runtime') return new Response('export * from "/react@18.3.1/es2022/jsx-runtime.mjs";');
  const body = cdn[url.pathname];
  return body ? new Response(body) : new Response('nope', { status: 404 });
}) as typeof fetch;

async function project(files: Record<string, string>) {
  const fs = new Vfs(new Bus<KernelEvents>());
  fs.mount('/', new MemFs());
  fs.markReady();
  for (const [p, t] of Object.entries(files)) await fs.writeFile(`/app/${p}`, t);
  return fs;
}

describe('npm specifiers', () => {
  it('splits scoped and plain names', () => {
    expect(splitSpecifier('@tanstack/react-query/devtools')).toEqual(['@tanstack/react-query', '/devtools']);
    expect(splitSpecifier('lodash/debounce')).toEqual(['lodash', '/debounce']);
    expect(pinVersion('^18.3.1')).toBe('18.3.1');
    expect(pinVersion('workspace:*')).toBeNull();
  });
  it('pins dependencies so shared packages load once', () => {
    const npm = new Npm({ dependencies: { react: '^18.3.1', 'react-dom': '~18.3.1' } });
    expect(npm.url('react-dom/client')).toBe('https://esm.sh/react-dom@18.3.1/client?target=es2022&dev');
    // react-dom's own import of a newer react is pointed at the pinned one.
    expect(npm.canonical('https://esm.sh/react@18.3.2/X-ZHJl/es2022/react.development.mjs')).toBe('https://esm.sh/react@18.3.1/es2022/react.development.mjs');
    expect(npm.canonical('https://esm.sh/scheduler@0.23.2/es2022/scheduler.mjs')).toBe('https://esm.sh/scheduler@0.23.2/es2022/scheduler.mjs');
    expect(npm.url('bootstrap/dist/css/bootstrap.css')).toBe('https://esm.sh/bootstrap/dist/css/bootstrap.css');
  });
});

describe('bundle', () => {
  it('bundles TSX, CSS, JSON, aliases and npm packages from the virtual filesystem', async () => {
    const fs = await project({
      'package.json': JSON.stringify({ dependencies: { react: '^18.3.1', tiny: '1.2.0' } }),
      'src/main.tsx': 'import tiny from "tiny"; import { label } from "@/lib/label"; import data from "./data.json"; import "./style.css"; const el = <b>{label}</b>; console.log(tiny(), data.n, el, import.meta.env.VITE_NAME);',
      'src/lib/label.ts': 'export const label: string = "from-alias";',
      'src/data.json': '{"n": 42}',
      'src/style.css': '@import "./base.css"; body { color: red }',
      'src/base.css': 'html { margin: 0 }',
    });
    const out = await bundle({ fs, root: '/app', entry: '/app/src/main.tsx', target: 'browser', pkg: JSON.parse(await fs.readText('/app/package.json')), env: { VITE_NAME: 'vite-env' }, fetcher });
    expect(out.errors).toEqual([]);
    expect(out.js).toContain('tiny-ok');
    expect(out.js).toContain('from-alias');
    expect(out.js).toContain('vite-env');
    expect(out.css).toContain('margin: 0');
    expect(out.css).toContain('color: red');
    expect(out.inputs).toContain('/app/src/lib/label.ts');
  });

  it('reports a missing import with where it came from', async () => {
    const fs = await project({ 'main.js': 'import "./nope.js";' });
    const out = await bundle({ fs, root: '/app', entry: '/app/main.js', target: 'browser', fetcher });
    expect(out.errors.join('\n')).toMatch(/Could not find "\.\/nope\.js"/);
  });

  it('keeps imports inside the project folder', async () => {
    const fs = await project({ 'main.js': 'import "../../etc/passwd.js";' });
    const out = await bundle({ fs, root: '/app', entry: '/app/main.js', target: 'browser', fetcher });
    expect(out.errors.join('\n')).toMatch(/outside the project folder/);
  });

  it('builds a backend as a script that exposes its handler', async () => {
    const fs = await project({ 'server.ts': 'export default { fetch: (req: Request) => new Response("hi " + new URL(req.url).pathname) };' });
    const out = await bundle({ fs, root: '/app', entry: '/app/server.ts', target: 'server', fetcher });
    expect(out.errors).toEqual([]);
    const mod = new Function(`${out.js}; return __bbxServer;`)() as { default: { fetch(r: Request): Response } };
    expect(await mod.default.fetch(new Request('http://localhost:3000/api')).text()).toBe('hi /api');
  });
});

describe('html', () => {
  it('inlines module scripts, stylesheets and images, and injects the runtime first', async () => {
    const fs = await project({
      'index.html': '<!doctype html><html><head><title>T</title><link rel="stylesheet" href="/style.css"></head><body><img src="logo.svg"><script type="module" src="/src/main.js"></script><script src="https://cdn.example/x.js"></script></body></html>',
      'style.css': 'body { color: blue }',
      'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'src/main.js': 'document.body.dataset.ok = "1"; console.log("</script>");',
    });
    const page = await renderHtml(fs, { root: '/app', htmlPath: '/app/index.html', path: '/', port: 3000, bundle: (entry) => bundle({ fs, root: '/app', entry, target: 'browser', fetcher }) });
    expect(page.errors).toEqual([]);
    expect(page.html.indexOf('__bbxDev')).toBeLessThan(page.html.indexOf('<title>'));
    expect(page.html).toContain('color: blue');
    expect(page.html).toContain('src="data:image/svg+xml;base64,');
    expect(page.html).toContain('dataset.ok');
    expect(page.html).not.toContain('"</script>"'); // escaped so the inline script is not cut short
    expect(page.html).toContain('src="https://cdn.example/x.js"');
  });

  it('writes a page for projects that only have src/main', async () => {
    const fs = await project({ 'src/main.jsx': 'console.log(1)' });
    const page = await renderHtml(fs, { root: '/app', htmlPath: null, path: '/', port: 3000, bundle: (entry) => bundle({ fs, root: '/app', entry, target: 'browser', fetcher }) });
    expect(page.html).toContain('<div id="root"></div>');
    expect(page.html).toContain('console.log(1)');
  });
});
