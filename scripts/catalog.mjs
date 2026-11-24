#!/usr/bin/env node
// Builds the official package index from packages/runtime/catalog/catalog.json:
// downloads every upstream file, records its sha256 and size, inlines the
// wrapper scripts, and writes packages/runtime/public/kernel/package-index.json.
//
//   node scripts/catalog.mjs              build the index
//   node scripts/catalog.mjs --check      download again and fail if a pinned file changed
//   node scripts/catalog.mjs --save DIR   also keep the downloads in DIR (for offline tests)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = new URL('../packages/runtime/', import.meta.url).pathname;
const catalog = JSON.parse(readFileSync(join(root, 'catalog/catalog.json'), 'utf8'));
const indexPath = join(root, 'public/kernel/package-index.json');
const check = process.argv.includes('--check');
const save = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : null;
const pinned = check ? JSON.parse(readFileSync(indexPath, 'utf8')) : null;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const out = [];
let problems = 0;
for (const p of catalog.packages) {
  const files = [];
  for (const f of p.files) {
    if (f.wrapper) {
      const text = readFileSync(join(root, 'catalog/wrappers', f.wrapper), 'utf8');
      files.push({ path: f.path, text, sha256: sha(Buffer.from(text)), bytes: Buffer.byteLength(text) });
      continue;
    }
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`${p.id}: ${f.url}: HTTP ${res.status}`);
    if (!/^\*$|jsdelivr|github/.test(res.headers.get('access-control-allow-origin') ?? '')) console.warn(`warning: ${f.url} sends no CORS header; browsers cannot download it`);
    const data = Buffer.from(await res.arrayBuffer());
    const sum = sha(data);
    if (pinned) {
      const was = pinned.packages.find((x) => x.id === p.id)?.files.find((x) => x.path === f.path);
      if (was && was.sha256 !== sum) (problems++, console.error(`CHANGED ${p.id} ${f.path}: pinned ${was.sha256.slice(0, 12)}…, now ${sum.slice(0, 12)}…`));
    }
    if (save) {
      const dest = join(save, p.id, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    }
    files.push({ path: f.path, url: f.url, sha256: sum, bytes: data.length });
  }
  const { files: _, ...rest } = p;
  out.push({ ...rest, files });
  console.log(`${p.id} ${p.version}: ${files.length} files, ${(files.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(2)} MB`);
}
if (check) {
  if (problems) process.exit(1);
  console.log('all pinned files unchanged');
} else {
  writeFileSync(indexPath, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), packages: out }, null, 1) + '\n');
  console.log(`wrote ${indexPath}`);
}
