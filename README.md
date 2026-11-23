# BrowserBox — a headless agent OS in the browser

BrowserBox is an operating system for AI agents that runs **entirely in the
browser**, with no backend. It is split into independent parts:

| Part | Path (or origin) | What it is |
|---|---|---|
| **Kernel** | `/kernel/` | Headless. A SharedWorker running the filesystem, process table, permissions, secrets, shells and agent sessions. No UI. |
| **Agent** | `/agent/` | The complete app: chat, built-in workbench (preview, files, editor, terminal, processes…) and settings, in one browser window. This is the default entry point. |
| **Desktop** | `/os/` | An optional GUI onto the same kernel, opened only when you ask for it (“Open desktop” in the agent window’s sidebar): a windowed desktop on wide screens, a phone home screen on phones. |
| **Docs** | `/docs/` | The user guide, a page of its own (no kernel; deep links like `/docs/#shipping`). The same docs open inside the app from ⋮ → **Help & docs**, the Help workbench tab, `/docs [topic]`, or the Help app on the desktop. Sources: `apps/browserbox/src/apps/help/docs/*.md`. |
| **Runtime** | `/embed/` (and `/runtime/` on the hosted site) | UI-less: the page the SDK loads in a hidden frame to drive a kernel from another site. |

The kernel keeps running as long as any BrowserBox window is open. Close the
agent window and its session carries on; open it again and it reattaches.
Close the desktop and nothing is lost — it is only a view. Any other frontend
can replace it by speaking the same protocol (`packages/runtime/src/kernel/api.ts`).

## Use it as a library (SDK)

BrowserBox is also a sandbox you can embed: a filesystem, a shell, and
JavaScript, Python and WebAssembly runtimes for agents or any untrusted code,
running on the user's device.

| Package | What it is |
|---|---|
| [`@jeevanand/agent-browserbox-sdk`](packages/sdk) | The SDK: `BrowserBox.boot()`, `box.fs`, `box.exec()`, `box.spawn()`. 3 kB, no dependencies. |
| [`@jeevanand/agent-browserbox-runtime`](packages/runtime) | The runtime the SDK drives, as static files to host yourself (`npx @jeevanand/agent-browserbox-runtime`). |
| [`@jeevanand/agent-browserbox`](packages/agent) | The agent: Claude or any OpenAI-compatible model, working inside a box with file, search, shell and JavaScript tools. |
| `@jeevanand/browserbox` | This app. Not on npm at the moment; use the hosted app or run it from source (below). |

```ts
import { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
const box = await BrowserBox.boot();
const { stdout } = await box.exec('echo hello from the box');
```

The SDK and the runtime are built from this repository (`packages/sdk`,
`packages/runtime`): `npm run build:sdk`, `npm run build:runtime`, and
`npm run e2e:sdk` tests them together across two origins in headless Chromium.

## Releases and the site

The products are released independently, and **only releases deploy**: a
push to `main` runs tests, never a deployment.

| Release | Tag | Goes to | Changelog |
|---|---|---|---|
| SDK + runtime | `sdk-v<version>` | npm (both packages), and the runtime to `/runtime/<version>/` on the site | `packages/sdk/CHANGELOG.md` |
| The agent | `agent-v<version>` | npm | `packages/agent/CHANGELOG.md` |
| The app | `app-v<version>` | the site: `/agent/`, `/os/`, `/docs/` (not npm) | `CHANGELOG.md` |

To release: bump the version (`packages/sdk` and `packages/runtime` together,
or the root `package.json` for the app), add its section to the changelog,
then **Actions → Release → Run workflow** and pick `sdk`, `agent` or `app`. The
workflow tests, publishes, writes the release notes from the changelog,
attaches a zip (the built runtime, or the built app), and then rebuilds the
site from all releases (`.github/workflows/pages.yml`):

- `/` is the newest app release;
- `/runtime/<version>/` is each runtime release, never changed once released;
  each SDK uses its own version's runtime by default;
- `/runtime/` is the newest runtime release.

A release only adds its own part: releasing the runtime never rebuilds the
app, and releasing the app never touches a runtime. Tests run per product
(`ci-sdk.yml`, `ci-agent.yml`, `ci-app.yml`), triggered by their own paths.

## Run it

Open the hosted app: https://jeevanandmaurya.github.io/agent-browserbox/agent/

Or run it from a clone of this repository:

```
npm install
npm run build
npm run serve
```

This serves the built app at `http://127.0.0.1:4173/agent/` and opens it.
The kernel, desktop and docs are on the same origin, with the cross-origin
isolation headers that SharedArrayBuffer and WebAssembly threads need.

```
--port <n>     port to listen on (default 4173, or the next free one)
--host <addr>  address to bind (default 127.0.0.1; use 0.0.0.0 for your LAN)
--no-open      don't open a browser window
--dir          print the path of the built site (to host it elsewhere) and exit
```

`--dir` prints the folder to point a static host at if you would rather not
use the built-in server. The app's service worker adds the same headers
there; keep `agent/`, `os/`, `docs/`, `runtime/` and `assets/` together.

## Development

```
npm install
npm run build      # the packages, then the app's static site in apps/browserbox/dist/
npm run dev        # http://localhost:5173/agent/  (desktop: /os/); serves the built runtime
npm test           # unit tests (vitest)
npm run smoke      # drives the built system end to end in headless Chromium (two suites)
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

and serve the runtime, `agent/` and `os/` from those
hosts. Nothing else changes: windows already reach the kernel only through a
hidden bridge frame and a message port. With separate origins that port becomes
a hard boundary — a window can no longer read the kernel's files or keys
directly, only ask. The subdomains must share one registrable domain you own
(not `github.io` or `vercel.app`), otherwise the browser partitions storage and
each window gets its own kernel. Mounting a local folder currently assumes the
window and kernel share an origin.

## Boot

Every window starts with a boot console: the kernel log (`dmesg`) as the
kernel mounts storage, loads its WebAssembly core and checks the platform.
First boot then runs `setup`, which asks a few things, all skippable with
Enter: your name (there is no account, so this is what greetings use), an
Anthropic API key (read without echo, stored encrypted), or failing that the
URL of a local model server. Everything else gets a default
(ask before acting, system theme, the small packages git, sqlite and zip).
Change any of it in Settings, or run `setup` again.

## The desktop

`/os/` picks its layout from the screen width and switches live, keeping
open apps:

- **Desktop** (wider than 640px): wallpaper; icons for apps and for the files
  in `~/Desktop` (drop files from your computer onto it); right-click menus on
  the desktop (new folder, new text file, open Terminal here, sort, show or
  hide icons, change wallpaper), on icons (open, open in Editor, rename,
  delete, copy path), on title bars and on taskbar buttons; windows snap to
  the left or right half or fill the screen when dragged to an edge; the
  taskbar has a launcher (Ctrl+K), notifications with history, a calendar on
  the clock and a show-desktop corner.
- **Phone**: a status bar (tap for quick settings and notifications), a home
  screen with a clock, app grid, search and dock; apps fill the screen. The
  home bar goes home on a tap or swipe up, and shows recent apps on a long
  press or a long swipe (tap a card to switch, swipe it up to close). The
  browser's back button goes home instead of leaving.
- **Wallpapers**: presets or your own picture, in Settings → Appearance.

The agent opens as a window on the desktop (full screen on phones); right-click it (long press on phones) and choose "Open in new tab" for a browser tab of its own.

## Building web apps: the dev server

Nothing in a browser can listen on a port, so BrowserBox has a virtual dev
server instead. `serve [folder]` (or `npm run dev`, `npx vite`, or the agent's
`dev_server` tool) serves a project at `http://localhost:3000/` and opens it
in Preview:

- **Pages**: `index.html`, or a generated page when the project only has
  `src/main.tsx` (`.ts`, `.jsx`, `.js`). Client-side routes get `index.html`.
- **Bundling**: esbuild (WebAssembly, the `esbuild` package, installed on
  first use) compiles TypeScript, JSX, CSS, CSS modules, JSON and assets.
  `import.meta.env` holds `VITE_`/`PUBLIC_` variables from `.env` files;
  `@/…` and tsconfig `paths` aliases work.
- **npm packages**: `npm install react` records the version in package.json;
  bare imports load from esm.sh at that version, one copy per package, and
  are cached for offline builds. There is no `node_modules`.
- **Backend**: a `server.ts` (or `server.js`, `api/index.ts`) that exports
  `default { fetch(request, env) }` answers the page's requests that are not
  project files. It stays loaded in a sandbox between requests, so in-memory
  state works; `env.fs` reads and writes project files; `.env` values are in
  `env`. It has no network unless started with `serve --net`.
- **Reload and console**: saving a file reloads Preview. Its console shows
  the page's output, uncaught errors, failed requests, build errors and the
  backend's output; the agent reads the same with `preview_logs`, so it can
  check that what it built actually works.

How it stays safe: the app runs in a sandboxed frame with an opaque origin,
so it cannot reach BrowserBox's storage, files or keys. Its `fetch()` and
`XMLHttpRequest` calls to its own address are forwarded to the dev server.
On GitHub Pages everything shares one origin and this frame is the
boundary; with your own domain, set `VITE_PREVIEW_URL` to give previews a
separate origin (`preview.example.com`).

Not supported: Node.js APIs in the backend (it runs on web APIs: `Request`,
`Response`, `fetch`, `crypto`), native modules, and tools that need Node
(the real Vite, Next.js, webpack).

## Shipping: GitHub and deploys

git's own HTTP protocol is not open to web pages, but GitHub's REST API is,
and so are Netlify's and Vercel's. BrowserBox uses them directly, with tokens
you add in **Settings → Accounts** (stored encrypted; only the kernel reads
them):

- `gh auth login | status | logout`
- `gh push [dir] [--repo owner/name] [--branch b] [-m msg]`: the folder's
  current files become one commit on the branch (only changed files are
  uploaded; `.gitignore` is respected; the repository is created, private,
  if it does not exist). The folder remembers where it was pushed.
- `gh repo create | clone`, `gh pr create --head b --title t`
- `build [dir]`: a production build — pages bundled, minified and inlined
  with their npm packages, dev-only code (`import.meta.env.DEV`) removed,
  other files copied — into `dist/`.
- `deploy [dir] --to netlify | vercel | github-pages`: builds, uploads only
  what the host lacks, waits until it is live and prints the URL. Later
  deploys of the folder update the same site. A `server.ts` backend is not
  deployed (these are static hosts).

The agent has the same through its `github` and `deploy` tools.

## Cross-origin isolation

**Settings → Environment → Isolate BrowserBox** turns on cross-origin
isolation, so `SharedArrayBuffer` and WebAssembly threads work. GitHub Pages
cannot send the COOP/COEP headers this needs, so the service worker adds them
(COEP `credentialless`, so CDNs and model downloads keep working). Sandboxes,
previews and pages in the Browser app are then embedded as `credentialless`
frames (Chrome and Edge; other browsers do not embed them while isolated).

## Packages

Optional software is installed with `pkg`, like any package manager. Python
(the `python` package) is CPython 3.13.2 compiled to WebAssembly by Pyodide
0.29; inside it, `pip install` uses micropip: pure-Python wheels from PyPI and
the packages Pyodide builds for WebAssembly (numpy, pandas, scipy,
matplotlib, scikit-learn…). Packages with other C extensions cannot install.
What you install is remembered and reinstalled in each new interpreter.
`python -m pip …`, `pip install -r requirements.txt`, `pip list` and
`pip uninstall` work.



```
pkg list            # i = installed, with sizes
pkg info python
pkg install git sqlite
pkg remove zip
```

A package is one folder, `packages/runtime/src/packages/<id>/`:

- `manifest.ts` — id, version, summary, the shell commands and agent tools it
  provides, and any remote files (Python's runtime comes from a CDN);
- `index.ts` — the code, exporting `{ commands, tools }`.

Nothing else needs changing to add one. The kernel finds manifests at build
time; the build gives each package its own chunk and records which files it
needs and how big they are (`kernel/packages.json`). Installing downloads
exactly those files into Cache Storage with a progress bar, so installed
packages work offline. Typing a command from a package that is not installed
says which package provides it.

## The agent window

`/agent/` is the chat app; nothing in it opens another window unless you click
“Open desktop”.

- **Header**: menu (chats) on the left, the chat title with the model name
  under it (tap to switch model), a spinner while the agent works, and ⋮ for
  files, terminal, preview, processes, context, compaction and settings.
- **Empty chat**: the BrowserBox mark and a greeting (Settings → Appearance
  takes a name for it).
- **Composer**: the message box, with a row underneath: **+** (attach
  files, commands), the context gauge, the model picker, dictation via the
  browser's speech recognition where available, and send. An empty chat
  shows the greeting and a taller box in the middle of the window. Menus
  open as bottom sheets on phones.
- **Conversation**: Markdown replies (rendered to DOM nodes, never
  `innerHTML`), collapsible thinking, tool calls as `tool argument` rows that
  expand to input and output, inline permission and question cards.
- **Private chat**: the ghost button on a new chat. Nothing is written to
  disk, it is not listed, and it ends when you leave it.
- **Workbench**: a side panel hosting the regular apps — Preview, Files,
  Editor, Terminal, Processes, Browser and others. Minimise it to a strip or
  expand it to the full width; on phones it is a bottom sheet you drag to any
  height (drag it down to minimise, up to fill the screen).
- **Settings**: a modal with Model, Permissions, Appearance, Connectors,
  Skills, Agents, Commands, Environment and Data.

- **Modes** (the chip next to +, or Shift+Tab): **Ask first** approves each
  change, command and network use; **Plan** lets the agent look around with
  read-only tools and answer with a plan, then offers **Run the plan**;
  **Auto** acts without asking (everything still runs in the sandbox).
- **Diffs and undo**: every file the agent writes or edits shows its diff in
  the chat. "N files changed · Review" opens the Changes panel: each file
  against how it was before this chat, with Open, Undo and Undo all.
  **Edit** on one of your messages goes back to it (and, if you choose, puts
  the files back too) and lets you resend. Only the file tools' changes are
  tracked; changes made by shell commands or scripts are not.
- **Queue and steer**: keep typing while the agent works; messages queue above
  the box and are sent when it finishes (**Send now** stops it and sends
  them). Esc stops the agent.
- **@files**: type @ to pick a file from the workspace; its contents go with
  the message.
- **Several chats at once**: switching chats leaves a running one working in
  the background; the sidebar marks chats that are working, or waiting for
  you.
- **Project instructions**: `AGENTS.md` (or `CLAUDE.md`) in the agent's
  folder is read at the start of every chat; `/init` has the agent write it.
  Other commands: `/plan`, `/changes`, `/compact`, `/context`, `/clear`.

The session lives in the kernel: closing the window detaches without stopping
it, and reopening returns to the same chat.

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
- **Local server** — Ollama, LM Studio, llama.cpp, vLLM on your machine or
  network. The tab talks straight to `http://localhost:…`; an API key is
  optional. The server must allow the page's origin, e.g.
  `OLLAMA_ORIGINS="*" ollama serve`.
- **OpenAI-compatible API** — hosted services such as OpenAI, OpenRouter,
  Groq, Together or Mistral, with your API key. Kept separate from the local
  server, so switching between them keeps both settings.
- **In this browser** — a model running on WebGPU via WebLLM in a worker.
  Nothing leaves the device. Small models get a reduced tool set. Settings →
  Model lists the models with the GPU memory each needs: download them (with
  progress; a cancelled download resumes), use, delete, free GPU memory, or
  import an MLC-compiled model from a folder on your computer
  (`mlc-chat-config.json`, `tensor-cache.json` or `ndarray-cache.json` with
  its shards, the tokenizer, and the WebGPU `.wasm` library).

### Hosted APIs that block web pages (CORS)

A web page may only call servers that allow it. OpenRouter, OpenAI and most
local servers do; **ollama.com does not** (it rejects the browser's preflight),
so no page can call it directly. Two ways round it:

- Run Ollama on your computer, sign in (`ollama signin`) and use **Local
  server**: local Ollama runs the `-cloud` models for you.
- Deploy the relay in [`relay/worker.js`](relay/worker.js) (free on Cloudflare
  Workers) and set its URL in Settings → Model → OpenAI-compatible API →
  Relay. It only forwards to the hosts in `ALLOWED_HOSTS` and only for pages
  from `ALLOWED_ORIGINS`; your API key passes through it, so run your own.

### Tokens, context and speed

Each reply ends with its time, output speed (tokens per second), tokens
written and the context size. The gauge next to the model picker shows how
full the context window is; open it for the split (system prompt, tools,
messages, tool results), the session's input, cached and output tokens, the
last reply's speed and time to first token, and a Compact button.

### Agent tools

`read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `delete_path`
`move_path` · `shell` `run_js` `run_python` `run_wasm` `gpu_compute` ·
`http_fetch` `open_app` `show_html` · `list_processes` `kill_process`
`system_info` · `notify` `clipboard_read` `clipboard_write` `speak` ·
`ask_user` `todo_write` `spawn_agent` · `dev_server` `preview_logs` (plus Claude's `web_search` / `web_fetch`).

## Agent features

| Feature | Where | How it works |
|---|---|---|
| Context meter | Header ring; `/context` | Shows how full the model's context window is and what is using it (system prompt, tool definitions, messages, tool calls, tool results). The total is the model's own figure after each reply; the split is estimated. |
| Compaction | `/compact`, or automatic at 85% | The model writes a summary that replaces the older messages for the model. The full history stays visible and saved. Toggle and local-model window size in Settings → Model. |
| Skills | `/home/agent/skills/<name>/SKILL.md`; Settings → Skills | Instructions plus supporting files. The agent sees names and descriptions and loads a skill with `use_skill` when a task matches. |
| Custom agents | `/home/agent/agents/<name>.md`; Settings → Agents | A role prompt and an optional `tools:` allow-list. The main agent delegates with `spawn_agent` and the sub-agent runs with a fresh context. |
| Slash commands | Type `/`; `/home/agent/commands/<name>.md` | Built-ins act on the window; custom commands are prompt templates (`$ARGUMENTS`). |
| Connectors (MCP) | Settings → Connectors | Remote MCP servers over Streamable HTTP, with an encrypted bearer token. *Direct* calls the server from the browser (it must allow CORS). *Through Claude* has Anthropic's API connect to it (Claude models only). Local stdio servers cannot run in a browser. |
| Environment | Settings → Environment | Variables visible as `$NAME` in the shell, `env.NAME` in `run_js` and `os.environ` in Python. Stored unencrypted; keep secrets in the key fields. |

Example skills, an `explorer` agent and an `/explain` command are created on first run; edit or delete them freely.

## Architecture

The repository is a monorepo of three released packages and the app built on them:

```
packages/
  sdk/            @jeevanand/agent-browserbox-sdk: BrowserBox.boot(), the client protocol (no dependencies)
  runtime/        @jeevanand/agent-browserbox-runtime: the machine, as static files, plus /client
    src/kernel/         event bus, VFS (OPFS · memory · native folders · /proc), processes,
                        permissions, settings, encrypted secrets; api.ts is its public interface
    src/kernel-worker/  worker entry and the RPC server that exposes the kernel
    src/kernel-host/    the hidden bridge page: starts the worker, hands out ports, hosts sandbox frames
    src/sandbox/        isolated JS / Python / WASI execution, WebGPU compute
    src/shell/          parser, interpreter, commands/, kernel-side shell sessions, contributed commands
    src/packages/       one directory per package (manifest + code), discovered automatically
    src/rpc/ src/config/  the message protocol; where each part is served from
    src/client/         RemoteKernel and the kernel types, published as /client
    embed/              the page the SDK embeds
    crates/kcore/       Rust → WebAssembly: hashing, line search, word count, token estimate
  agent/          @jeevanand/agent-browserbox: loop, sessions, providers (anthropic · openai · webllm),
                  tools, MCP, skills, publishing; drives a box through the SDK
apps/
  browserbox/     the BrowserBox app (private, released as a site): windows, desktop, apps,
                  the agent worker; imports only the three packages
```

### Layers

The runtime is layered so the kernel ships without a shell or packages, and the
app reaches the runtime only through its published entry points:

| Layer | Folders | May import |
|---|---|---|
| core | `runtime/src/{kernel,kernel-worker,sandbox,rpc,config}` | core only |
| shell | `runtime/src/shell` | core, shell |
| packages | `runtime/src/packages` | core, shell, packages |
| client | `runtime/src/client` | the kernel's types |
| app | `apps/browserbox` | `@jeevanand/agent-browserbox-sdk`, `…-runtime/client`, `@jeevanand/agent-browserbox` |

`tests/layers.test.ts` fails the build if a lower layer imports a higher one or
the app imports package sources. Higher layers plug in by registering:

- **Shell commands** from outside the runtime are contributed over the kernel
  connection (`shell.contribute`); the agent contributes `agent`, `setup`, `gh`, `deploy`.
- **Packages** are handed to the kernel as a registry; what a package can
  contain is declared by the layers that use it (`commands` by the shell, `tools` by the agent).
- **Apps** are listed for the shell and the agent with `registerApps`.

To add an app, create `apps/browserbox/src/apps/<id>/` with a `manifest.ts`
and an `index.ts` exporting an `AppModule`; to add a package, create
`packages/runtime/src/packages/<id>/` the same way. Shell commands live in
`packages/runtime/src/shell/commands/*`, agent tools in `packages/agent/src/tools/*`.

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
- The shell is not bash; there is no npm, apt or native compiler. Packages
  (`pkg list`) add Python, git for local repositories, `sqlite3` and `zip`/`unzip`.
  `git clone` needs a relay you configure (`git config http.corsProxy …`),
  because Git hosts block direct browser access; push is not implemented.
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

## License

MIT — see [LICENSE](LICENSE).
