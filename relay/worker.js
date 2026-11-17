// A small CORS relay for BrowserBox, for hosted model APIs that do not accept
// requests from web pages (ollama.com, for example).
//
// Deploy (free) on Cloudflare Workers:
//   npx wrangler deploy relay/worker.js --name bbx-relay --compatibility-date 2025-01-01
// then set the URL it prints (https://bbx-relay.<you>.workers.dev) in
// BrowserBox → Settings → Model → OpenAI-compatible API → Relay.
//
// BrowserBox sends   https://<relay>/https://ollama.com/v1/chat/completions
// and the relay forwards it to   https://ollama.com/v1/chat/completions,
// streaming the answer back with CORS headers added.
//
// It is not an open proxy: only hosts in ALLOWED_HOSTS are forwarded, and only
// for pages from ALLOWED_ORIGINS. Set both as Worker variables, e.g.
//   ALLOWED_HOSTS   = ollama.com
//   ALLOWED_ORIGINS = https://<you>.github.io
// Your API key passes through this Worker; nothing is stored.

const FORWARD_HEADERS = ['authorization', 'content-type', 'accept', 'x-api-key', 'anthropic-version'];

const list = (v, fallback) => (v || fallback).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get('origin') || '';
    const origins = list(env.ALLOWED_ORIGINS, '');
    const originOk = !origins.length || origins.includes(origin.toLowerCase());
    const cors = {
      'access-control-allow-origin': originOk && origin ? origin : 'null',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': FORWARD_HEADERS.join(', '),
      'access-control-max-age': '86400',
      vary: 'origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (!originOk) return new Response('This page may not use the relay (ALLOWED_ORIGINS).', { status: 403, headers: cors });

    const url = new URL(request.url);
    // Some front ends collapse "//" in paths: accept https:/host as well as https://host.
    const raw = (url.pathname.slice(1) + url.search).replace(/^(https?):\/+/i, '$1://');
    let target;
    try {
      target = new URL(raw);
    } catch {
      return new Response('Use https://<relay>/https://api.example.com/v1/…', { status: 400, headers: cors });
    }
    const hosts = list(env.ALLOWED_HOSTS, 'ollama.com');
    if (target.protocol !== 'https:' || !hosts.some((h) => target.hostname === h || target.hostname.endsWith(`.${h}`))) {
      return new Response(`${target.hostname} is not in ALLOWED_HOSTS.`, { status: 403, headers: cors });
    }
    const headers = new Headers();
    for (const name of FORWARD_HEADERS) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v);
    }
    const upstream = await fetch(target, { method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body });
    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    out.delete('set-cookie');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
