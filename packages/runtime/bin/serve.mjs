#!/usr/bin/env node
// Serves the BrowserBox runtime locally, for @jeevanand/agent-browserbox's `runtimeUrl`.
//
//   npx @jeevanand/agent-browserbox-runtime [--port 4180] [--host 127.0.0.1] [--dir]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { runtimeDir as DIST } from '../index.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
if (args.includes('-h') || args.includes('--help')) {
  console.log(`Serves the BrowserBox runtime for the @jeevanand/agent-browserbox SDK.

Usage: agent-browserbox-runtime [options]
  --port <n>     port to listen on (default 4180, or the next free one)
  --host <addr>  address to bind (default 127.0.0.1)
  --dir          print the path of the runtime files (to host them elsewhere) and exit`);
  process.exit(0);
}
if (args.includes('--dir')) {
  console.log(DIST);
  process.exit(0);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const HEADERS = {
  // Lets the runtime frame be embedded by isolated pages too, and its files be fetched cross-origin.
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(DIST, path));
    if (file !== DIST && !file.startsWith(DIST + sep)) return res.writeHead(403).end();
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      if (!path.endsWith('/')) return res.writeHead(301, { Location: path + '/' }).end();
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    const body = await readFile(file);
    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

const host = opt('--host', '127.0.0.1');
let port = Number(opt('--port', 4180));
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !args.includes('--port')) return server.listen(++port, host);
  console.error(e.message);
  process.exit(1);
});
server.listen(port, host, () => {
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`;
  console.log(`BrowserBox runtime at ${url}\nUse it with: BrowserBox.boot({ runtimeUrl: '${url}' })\nPress Ctrl+C to stop.`);
});
