# Advanced

## Cross-origin isolation (SharedArrayBuffer)

**Settings → Environment → Isolate BrowserBox** turns on cross-origin isolation, which `SharedArrayBuffer` and WebAssembly threads need. BrowserBox's service worker adds the required headers, so it works on any host. Reload every BrowserBox window after changing it.

With it on, code sandboxes, previews and pages in the Browser app keep working in Chrome and Edge. **In Firefox, leave it off**: sandboxes and previews do not load there while isolated.

## Hosting your own copy

BrowserBox is static files. Build with `npm run build` and serve `dist/` anywhere. With your own domain you can put the parts on separate origins (`VITE_KERNEL_URL`, `VITE_AGENT_URL`, `VITE_OS_URL`, `VITE_PREVIEW_URL`) for stronger separation.

## The relay

Some services do not accept requests from web pages. `relay/worker.js` in the repository is a small Cloudflare Worker that forwards requests only to the hosts you allow, only for your site. Set its address in Settings → Model → OpenAI-compatible API → Relay, or for git with `git config http.corsProxy`.
