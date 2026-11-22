#!/usr/bin/env node
// Serves the prebuilt BrowserBox (kernel + agent + desktop + docs) on localhost and opens it.
//
//   npx @jeevanand/browserbox-app [--port 4173] [--host 127.0.0.1] [--no-open] [--dir]
//
// No dependencies: BrowserBox is a static site, so all this needs is a file server that sends
// the cross-origin isolation headers (SharedArrayBuffer, WebContainers) and correct MIME types.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
if (args.includes("-h") || args.includes("--help")) {
  console.log(`BrowserBox: an agent OS that runs entirely in your browser.

Usage: browserbox [options]
  --port <n>     port to listen on (default 4173, or the next free one)
  --host <addr>  address to bind (default 127.0.0.1; use 0.0.0.0 for your LAN)
  --no-open      don't open a browser window
  --dir          print the path of the built site (to host it elsewhere) and exit
  -h, --help     show this help`);
  process.exit(0);
}
if (args.includes("--dir")) {
  console.log(DIST);
  process.exit(0);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};
const HEADERS = {
  // Same isolation the app's own service worker applies on static hosts.
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = normalize(join(DIST, path));
    if (file !== DIST && !file.startsWith(DIST + sep)) return res.writeHead(403).end();
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      if (!path.endsWith("/")) return res.writeHead(301, { Location: path + "/" }).end();
      file = join(file, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info) return res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    const body = await readFile(file);
    res.writeHead(200, {
      ...HEADERS,
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

const host = opt("--host", "127.0.0.1");
let port = Number(opt("--port", 4173));
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && !args.includes("--port")) return server.listen(++port, host);
  console.error(e.message);
  process.exit(1);
});
server.listen(port, host, () => {
  const shown = host === "0.0.0.0" ? "localhost" : host;
  const url = `http://${shown}:${port}/agent/`;
  console.log(`BrowserBox is running at ${url}\n(desktop: http://${shown}:${port}/os/ · docs: http://${shown}:${port}/docs/)\nPress Ctrl+C to stop.`);
  if (!args.includes("--no-open")) {
    const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); } catch {}
  }
});
