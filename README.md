# BrowserBox — an agent OS in a browser tab

BrowserBox is a small operating system for AI agents that runs **entirely in the
browser**. There is no backend: the filesystem, the shell, the code sandboxes,
the window manager and the agent loop all live in the tab. The only network
traffic is the model requests you configure (or none at all with an in-browser
model).

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ — host it anywhere
npm test           # unit tests (vitest)
npm run smoke      # boots the build in headless Chromium and exercises it end to end
```

## What is in it

| | |
|---|---|
| **Agent** (GUI) | Chat with streaming replies, tool cards, inline approvals, a task list, saved sessions. |
| **Agent** (CLI) | `agent "task"` in the Terminal, or `agent` for an interactive session. |
| **Terminal** | A POSIX-flavoured shell: pipes, redirects, `&&`/`\|\|`/`;`, `$VARS`, globs, history, tab completion, ~45 commands. |
| **Task Manager** | Every app, agent, sandbox and service is a process you can inspect and kill; live performance charts. |
| **Files / Editor / Preview** | File manager, code editor with run buttons, and a sandboxed viewer for HTML, images, media, Markdown. |
| **Browser** | Framed browsing plus a CORS-based reader mode. |
| **GPU Lab** | WGSL fragment-shader playground and compute benchmarks on WebGPU. |
| **System / Settings** | Capability report, storage, boot timeline; model, permission and appearance settings. |

### Models

Pick one in **Settings → Model**:

- **Claude** (Anthropic API, called directly from the tab with the official SDK).
  Default `claude-opus-5-5`; adaptive thinking, streaming, prompt caching,
  refusal fallbacks and optional server-side web search are enabled.
- **A local or OpenAI-compatible server** — Ollama, LM Studio, llama.cpp, vLLM.
  The tab talks straight to `http://localhost:…`. The server must allow the
  page's origin, e.g. `OLLAMA_ORIGINS="*" ollama serve`.
- **In this browser** — a model running on WebGPU via WebLLM in a worker.
  Nothing leaves the device. Small models get a reduced tool set.

### Agent tools

`read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `delete_path`
`move_path` · `shell` `run_js` `run_python` `run_wasm` `gpu_compute` ·
`http_fetch` `open_app` `show_html` · `list_processes` `kill_process`
`system_info` · `notify` `clipboard_read` `clipboard_write` `speak` ·
`ask_user` `todo_write` `spawn_agent` (plus Claude's `web_search` / `web_fetch`).

## Architecture

```
src/
  kernel/     event bus, VFS (OPFS · memory · native folders · /proc), process table,
              permissions, settings, encrypted secrets, capability detection, kcore bindings
  sandbox/    isolated JS / Python / WASI execution, WebGPU compute
  shell/      parser, interpreter, commands/
  agent/      loop, prompt, sessions, providers/ (anthropic · openai · webllm), tools/
  ui/         window manager, desktop, dialogs, app host, markdown
  apps/       one directory per app, each lazy-loaded
crates/kcore/ Rust → WebAssembly: hashing, line search, word count, token estimate
public/       sandbox frames, service worker, manifest
```

Modules only meet through the `Kernel` object and its typed event bus. To add an
app, create `src/apps/<id>/index.ts` exporting an `AppModule` and add one line
to `APPS` in `src/ui/apps.ts`. To add a shell command or an agent tool, append
it to the list in `src/shell/commands/*` or `src/agent/tools/*`.

### Why it boots fast

The kernel and desktop are constructed synchronously in one ~14 kB (gzip)
bundle, so the first frame is the usable desktop (≈50–100 ms in headless
Chromium). Storage, the WASM core and the service worker start afterwards.
Every app and every model adapter is a separate chunk fetched on first use, and
the service worker makes later boots offline-capable.

### Security model

- **Untrusted code never runs in the app's origin.** `run_js`, `run_python` and
  `run_wasm` execute in a Worker inside an `<iframe sandbox="allow-scripts">`:
  an opaque origin with no access to OPFS, IndexedDB, cookies or the DOM. A CSP
  on the frame blocks the network unless it was granted. The only way out is a
  message port exposing a small filesystem RPC. Runaway code is killed by
  removing the frame.
- **Capabilities.** Writing outside the agent's workspace, running code, using
  the network, the clipboard and killing processes each need a grant (once,
  always, or deny). *Auto* mode allows everything inside the sandbox.
- **The VFS is the boundary.** The agent can only see the virtual filesystem;
  real folders appear only if you mount them under `/mnt`.
- **Secrets** (API keys) are encrypted with a non-extractable AES-GCM key in
  IndexedDB and are never written to settings or the filesystem.
- **Model output is never parsed as HTML.** Markdown is rendered to DOM nodes;
  agent-authored pages are shown in a sandboxed frame. The host page has a
  strict CSP (`script-src 'self' 'wasm-unsafe-eval'`).
- Tool inputs are validated against their schemas before running.

### Web platform APIs in use

WebAssembly (Rust core, WASI, Pyodide) · WebGPU (compute tool, GPU Lab,
in-browser LLM) · OPFS · File System Access · IndexedDB · Web Crypto · Web
Workers · Service Worker + Cache Storage · Streams / streaming fetch ·
Compression Streams · Storage persistence & estimates · Screen Wake Lock ·
Notifications · Async Clipboard · Speech Synthesis · PerformanceObserver ·
Web App Manifest. `System → Capabilities` (or `sysinfo` in the shell) shows what
your browser supports.

## Limits worth knowing

- Browsers enforce CORS: `http_fetch`/`curl` only reach servers that allow it,
  and most sites cannot be framed in the Browser app.
- The shell is not bash; there is no git, package manager or native compiler.
- Python needs a one-time download of Pyodide from jsDelivr.
- Without OPFS the root filesystem falls back to memory and is lost on reload.
- A browser tab is not a security boundary against the browser itself; the
  sandbox protects your data in this origin from code the agent runs.

## Rebuilding the Rust core

`src/kernel/kcore.wasm` is checked in. To rebuild:
`rustup target add wasm32-unknown-unknown && npm run build:wasm`.
