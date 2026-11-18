# Advanced

## Cross-origin isolation (SharedArrayBuffer)

**Settings → Environment → Isolate BrowserBox** turns on cross-origin isolation, which `SharedArrayBuffer`, WebAssembly threads and real Node.js need. BrowserBox's service worker adds the required headers, so it works on any host. Reload every BrowserBox window after changing it.

With it on, code sandboxes, previews and pages in the Browser app keep working in Chrome and Edge. **In Firefox, leave it off**: sandboxes and previews do not load there while isolated.

## Real Node.js (the node package)

With isolation on, `pkg install node` adds real Node.js and npm, through StackBlitz WebContainers:

- `node`, `npm install`, `npm run …` and `npx` run for the current project (the folder with `package.json`).
- Your files are copied in before a command, edits follow it while it runs (dev servers reload), and what it changed comes back afterwards. `node_modules` stays inside.
- A server that starts listening opens in the Browser app. **Ctrl+C** stops it.

The runtime is downloaded from StackBlitz each session, so it needs a connection. StackBlitz's terms apply: free for personal and open-source use; commercial production use needs their licence.

## Hosting your own copy

BrowserBox is static files. Build with `npm run build` and serve `dist/` anywhere. With your own domain you can put the parts on separate origins (`VITE_KERNEL_URL`, `VITE_AGENT_URL`, `VITE_OS_URL`, `VITE_PREVIEW_URL`) for stronger separation.

## The relay

Some services do not accept requests from web pages. `relay/worker.js` in the repository is a small Cloudflare Worker that forwards requests only to the hosts you allow, only for your site. Set its address in Settings → Model → OpenAI-compatible API → Relay, or for git with `git config http.corsProxy`.
