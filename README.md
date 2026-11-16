# BrowserBox — a headless agent OS in the browser

BrowserBox is an operating system for AI agents that runs **entirely in the
browser**, with no backend. It is split into independent parts:

| Part | Path (or origin) | What it is |
|---|---|---|
| **Kernel** | `/kernel/` | Headless. A SharedWorker running the filesystem, process table, permissions, secrets, shells and agent sessions. No UI. |
| **Agent** | `/agent/` | The complete app: chat, built-in workbench (preview, files, editor, terminal, processes…) and settings, in one browser window. This is the default entry point. |
| **Desktop** | `/os/` | An optional windowed GUI onto the same kernel, opened only when you ask for it (“Open desktop” in the agent window’s sidebar). |

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

## The agent window

`/agent/` is a self-contained chat app; nothing in it opens another window
unless you click “Open desktop”.

- **Sidebar** (a drawer on phones): New chat, search over saved chats, recent
  chats grouped by date (delete on hover), Settings, kernel status (opens the
  process list) and a low-key “Open desktop” link.
- **Conversation**: an empty state with a centered composer and suggestions;
  after the first message the composer docks at the bottom. Replies stream as
  Markdown (rendered to DOM nodes, never `innerHTML`), with collapsible
  thinking, compact tool rows that expand to input and output, inline
  permission and `ask_user` cards, notes, errors, a task list and a copy button.
- **Composer**: auto-growing; Enter sends, Shift+Enter adds a line. Attach
  copies files into `/home/agent/uploads/` and adds their paths to the message.
  The model picker switches between configured models and effort, and links to
  model settings.
- **Workbench** (right panel, resizable; a full-screen sheet on phones): tabs
  that host the regular app modules inside the page — Preview (where
  `show_html` output appears), Files, Editor, Terminal, Processes, Browser,
  GPU Lab, System. Each app is fetched on first use, keeps running while its
  tab is hidden, and gets its own kernel process. The agent's `open_app` /
  `show_html` requests open here (`src/apps/agent/panel-host.ts`).
- **Settings** open in a modal (full-screen on phones), deep-linkable by
  section: model, permissions, appearance, tools, data.
- **First-run setup**: style (casual or developer profile, theme), model,
  permissions and optional tool packs (`src/agent/packs.ts`). Skippable with
  “Use defaults”; run it again from Settings → Tools. The developer profile is
  denser, opens Terminal and Files beside the chat, expands tool calls and
  shows kernel status; casual keeps tool calls to one-line summaries.

The session lives in the kernel: closing the window detaches without stopping
it, reopening reattaches, and “New chat” starts a fresh one.

## What is in it

| | |
|---|---|
| **Agent** (GUI) | The agent window above: chat, workbench, settings, saved sessions. |
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
  apps/           one directory per app, each lazy-loaded; apps/agent/ is the agent window
                  (shell, sidebar, composer, transcript, workbench + panel host, settings modal, setup)
crates/kcore/     Rust → WebAssembly: hashing, line search, word count, token estimate
```

Apps, the shell and the agent are written against the `Kernel` interface. The
real kernel (`KernelCore`) implements it in the worker; `RemoteKernel`
implements it in each window. To add an app, create `src/apps/<id>/index.ts`
exporting an `AppModule` and add it to `APPS` in `src/ui/apps.ts`; to run an app
as its own window, mount it with `mountStandalone` as `src/pages/agent.ts` does;
to embed it in a pane of another page, use `mountPanelApp` from
`src/apps/agent/panel-host.ts`.
To add a shell command or an agent tool, append it to the list in
`src/shell/commands/*` or `src/agent/tools/*`.

### Why it boots fast

The agent window loads about 30 kB (gzip) of script and is usable roughly
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
