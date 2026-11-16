# BrowserBox — a headless agent OS in the browser

BrowserBox is an operating system for AI agents that runs **entirely in the
browser**, with no backend. It is split into independent parts:

| Part | Path (or origin) | What it is |
|---|---|---|
| **Kernel** | `/kernel/` | Headless. A SharedWorker running the filesystem, process table, permissions, secrets, shells and agent sessions. No UI. |
| **Agent** | `/agent/` | The agent in its own browser window. This is the default entry point. |
| **Desktop** | `/os/` | An optional GUI (files, terminal, task manager…) loaded only on demand. |

The kernel keeps running as long as any BrowserBox window is open. Close the
agent window and its session carries on; open it again and it reattaches.
Close the desktop and nothing is lost — it is only a view. Any other frontend
can replace it by speaking the same protocol (`src/kernel/api.ts`).

```
npm install
npm run dev        # http://localhost:5173/agent/  (desktop: /os/)
npm run build      # static site in dist/ — host it anywhere
npm test           # unit tests (vitest)
npm run smoke      # drives the built system end to end in headless Chromium
```

### Paths now, origins later

By default the three parts are sibling paths on one origin. To put each on its
own origin, build with:

```
VITE_KERNEL_URL=https://kernel.example.com/
VITE_AGENT_URL=https://agent.example.com/
VITE_OS_URL=https://os.example.com/
VITE_ALLOWED_ORIGINS=https://agent.example.com,https://os.example.com
```

and serve `dist/kernel/` + `dist/assets/`, `dist/agent/`, `dist/os/` from those
hosts. Nothing else changes: windows already reach the kernel only through a
hidden bridge frame and a message port. With separate origins that port becomes
a hard boundary — a window can no longer read the kernel's files or keys
directly, only ask. The subdomains must share one registrable domain you own
(not `github.io` or `vercel.app`), otherwise the browser partitions storage and
each window gets its own kernel. Mounting a local folder currently assumes the
window and kernel share an origin.

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
  kernel/         the kernel: event bus, VFS (OPFS · memory · native folders · /proc),
                  process table, permissions, settings, encrypted secrets; api.ts is its public interface
  kernel-worker/  worker entry point and the RPC server that exposes the kernel to windows
  kernel-host/    the hidden bridge page: starts the worker, hands out ports, hosts sandbox frames
  client/         RemoteKernel — a window's handle on the kernel (mirrors state, forwards calls)
  rpc/            the message protocol
  config/         where each part is served from (paths or origins)
  sandbox/        isolated JS / Python / WASI execution, WebGPU compute
  shell/          parser, interpreter, commands/, kernel-side shell sessions
  agent/          loop, sessions, providers/ (anthropic · openai · webllm), tools/
  pages/          entry points: agent window, desktop
  ui/             window manager, desktop, dialogs, app host, standalone page host
  apps/           one directory per app, each lazy-loaded
crates/kcore/     Rust → WebAssembly: hashing, line search, word count, token estimate
```

Apps, the shell and the agent are written against the `Kernel` interface. The
real kernel (`KernelCore`) implements it in the worker; `RemoteKernel`
implements it in each window. To add an app, create `src/apps/<id>/index.ts`
exporting an `AppModule` and add it to `APPS` in `src/ui/apps.ts`; to run an app
as its own window, mount it with `mountStandalone` as `src/pages/agent.ts` does.
To add a shell command or an agent tool, append it to the list in
`src/shell/commands/*` or `src/agent/tools/*`.

### Why it boots fast

The agent window loads about 20 kB (gzip) of script and is usable roughly
100 ms after navigation in headless Chromium; the kernel worker boots in
parallel. The desktop, every app and every model adapter are separate chunks
fetched only when used, and the service worker makes later boots
offline-capable.

### Security model

- **Windows are clients, not owners.** The kernel exposes a fixed set of RPC
  methods; secrets can be written from a window but never read back.
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
- The kernel lives only while at least one BrowserBox window is open; browsers
  have no true background processes.
- Browsers without SharedWorker run one kernel per window (files and settings
  are still shared; the process table is not).
- Sandboxed code runs in a frame hosted by an open window, so it stops if that
  window closes mid-run.
- A browser tab is not a security boundary against the browser itself; the
  sandbox protects your data in this origin from code the agent runs.

## Rebuilding the Rust core

`src/kernel/kcore.wasm` is checked in. To rebuild:
`rustup target add wasm32-unknown-unknown && npm run build:wasm`.
