#!/usr/bin/env node
// The BrowserBox relay, on your own computer instead of Cloudflare.
//
//   node relay/local.mjs
//
// then in BrowserBox → Settings → Model → API → Relay: http://localhost:8787
// BrowserBox's requests go from the page to this process, and from here to the
// API (with your key, which is not stored). Only this computer can reach it
// (it listens on 127.0.0.1), and by default only BrowserBox's pages may use it.
//
// Settings, as environment variables:
//   PORT=8787
//   ALLOWED_HOSTS=ollama.com,...        APIs it forwards to (exact hosts or their subdomains)
//   ALLOWED_ORIGINS=https://...          pages that may use it (comma-separated)
//
// Needs Node.js 18 or later; nothing to install.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import worker from './worker.js';

const port = Number(process.env.PORT || 8787);
const env = {
  ALLOWED_HOSTS: process.env.ALLOWED_HOSTS || 'ollama.com,generativelanguage.googleapis.com,api.openai.com,api.anthropic.com,openrouter.ai,api.groq.com,api.together.xyz,api.mistral.ai,api.deepseek.com,api.x.ai',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'https://jeevanandmaurya.github.io,http://localhost:5173,http://localhost:4173',
};

createServer(async (req, res) => {
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body, duplex: 'half' });
    const answer = await worker.fetch(request, env);
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (!answer.body) return res.end();
    // Streamed as it comes, so replies appear as the model writes them.
    for await (const chunk of answer.body) res.write(chunk);
    res.end();
    console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${decodeURIComponent(req.url.slice(1)).split('?')[0]} → ${answer.status}`);
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`relay: ${err.message}`);
    console.error(`relay error: ${err.message}`);
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`BrowserBox relay on http://localhost:${port}`);
  console.log(`  forwards to: ${env.ALLOWED_HOSTS}`);
  console.log(`  for pages:   ${env.ALLOWED_ORIGINS}`);
  console.log('In BrowserBox: Settings → Model → API → Relay → http://localhost:' + port);
});
