# Plan: the package manager, and the browser platform (runtime 0.5)

Status: done for the package manager (3.1–3.8), the first catalog, and
platform items 4.1 #1–5 (honest capability list, notifications, screen
capture, passkeys, the built-in model). Items 6–10 and Settings → Packages
are next. Was: proposal. Covers three questions: why an x86 emulator is heavier than
BrowserBox's kernel; how the runtime's package manager should grow (JS, WASM
and terminal packages, and a complete set of package operations); and which
browser features BrowserBox uses, detects only, or ignores.

---

## 1. Why an x86 machine in the browser is heavier than this kernel

Projects such as v86, WebVM and JSLinux run a real PC in the page: they
emulate an x86 CPU and boot an ordinary Linux. BrowserBox does not emulate a
machine; its kernel is written for the browser. The cost difference follows:

| | x86 emulation (v86, WebVM) | BrowserBox kernel |
|---|---|---|
| What runs | Every x86 instruction of the Linux kernel and every program, translated (JIT) into WebAssembly or interpreted | JavaScript and WebAssembly that the browser runs natively |
| Speed | Typically several times slower than native for CPU work; system calls cross an emulated kernel and emulated devices | The browser's own speed: commands are functions, files are OPFS calls |
| Download | A Linux kernel plus a disk image: tens to hundreds of MB (streamed on demand) | The runtime is about 1.2 MB; packages download only when installed |
| Memory | A whole machine's RAM reserved up front (128 MB–2 GB in one buffer), plus the emulator and page tables | What the running programs use |
| Boot | Seconds: BIOS, kernel, init | Tens of milliseconds |
| Files | A disk image inside the emulator; reaching browser storage needs a bridge | The root filesystem is the browser's storage (OPFS) directly |
| Networking | Emulated network card, tunnelled through a relay (browsers have no raw sockets) | The browser's fetch, with its rules (CORS) |
| What it can run | Any unmodified Linux program: apt, gcc, node, python | Only software built for the web: JavaScript, WebAssembly (WASI), Pyodide |

So the trade-off is compatibility against cost: x86 runs everything,
slowly and heavily; BrowserBox runs web software at full speed and almost no
weight. It also means BrowserBox's software has to arrive as JS or WASM
packages: hence the package manager below. (An x86 package could even be
offered later for the rare program that needs it: a heavy, optional download
the user chooses, not the default.)

---

## 2. The package manager today

- Five packages, all compiled into the runtime build: esbuild, git, python,
  sqlite, zip. A package is a code chunk of the build plus optional remote
  files (Python's runtime), cached in Cache Storage for offline use.
- Operations: `pkg list`, `pkg info`, `pkg install`, `pkg remove`, and
  `pkg install --defaults`.
- Missing: packages from outside the build, dependencies, versions and
  updates, search, integrity checks on downloads, a way to add a JS or WASM
  program, and Tab completion for `pkg`.
- The runtime runs WASI programs (`wasm prog.wasm`), but with standard
  input/output only: the filesystem system calls are not implemented, so a
  WASM tool cannot open, list or write files.

---

## 3. The package manager, complete

### 3.1 Kinds of package

| Kind | What it is | How its commands run | Examples |
|---|---|---|---|
| `builtin` | Code compiled into the runtime (today's five) | In the kernel, as now; can add agent tools | git, python, sqlite, zip, esbuild |
| `wasm` | WASI programs (`.wasm` files) | In the WASI sandbox, with the box's files (3.3) | jq, Lua, QuickJS, coreutils (uutils), SQLite CLI, clang (later, large) |
| `js` | JavaScript command-line programs (ES modules) | In the JS sandbox worker, with a small Node-style shim (`process.argv`, `process.stdout`, `fs/promises` on the box's files, `path`) | prettier, marked, js-yaml, typescript (tsc), csvkit-like tools |
| `script` | Commands written as BrowserBox shell or JS scripts | The shell runs them (`.sh`) or `js` (`.js`) | Your own commands; small utilities; aliases |

Every kind installs the same way, lists the same way, and gives commands that
appear in `help`, Tab completion and the agent's prompt.

### 3.2 The package format

One manifest per package, `bbx-package.json`:

```json
{
  "id": "jq",
  "version": "1.7.1",
  "kind": "wasm",
  "summary": "Command-line JSON processor",
  "license": "MIT",
  "homepage": "https://jqlang.org",
  "files": [{ "path": "jq.wasm", "url": "https://…/jq-1.7.1-wasi.wasm", "sha256": "…", "bytes": 1230000 }],
  "commands": { "jq": { "run": "jq.wasm" } },
  "depends": []
}
```

- `files`: everything to download, each with a **sha256** that is checked
  before the file is used. A mismatch fails the install.
- `commands`: name → the file to run (and fixed leading arguments, for
  tools with several entry points, e.g. coreutils' `ls`, `cat`).
- `depends`: other package ids (with `>=` versions), installed first.
- Builtin packages keep their TypeScript manifest; the build turns them into
  the same shape so everything else treats all kinds alike.

### 3.3 WASI with files (needed for `wasm` packages)

Implement the WASI preview1 filesystem calls in the sandbox, backed by the
box's virtual filesystem: `path_open`, `fd_read/fd_write/fd_seek/fd_tell` on
files, `fd_readdir`, `path_filestat_get`, `fd_filestat_get`,
`path_create_directory`, `path_unlink_file`, `path_remove_directory`,
`path_rename`, `fd_close`, `fd_prestat_get/dir_name` (preopens: the working
folder as `.` and `/`). The program runs in its sandbox worker; file access
goes back to the kernel as messages (async, batched; a SharedArrayBuffer
fast path when the page is cross-origin isolated). `/mnt` access keeps asking
permission, as for every other program.

### 3.4 Where packages come from (trust)

1. **Built in**: the five compiled into the runtime.
2. **The BrowserBox index**: `packages/index.json` published with each
   runtime release (`/runtime/<v>/packages/index.json`), a curated list
   where every file is pinned to a URL and a sha256. Installing from it needs
   no extra confirmation.
3. **Other sources the user adds** (`pkg source add <url>`): another index
   in the same format. Adding one asks "Trust packages from <host>?" once.
4. **One-off**: `pkg install <url to bbx-package.json>` or a local file. Asks
   every time, showing what it will download and which commands it adds.

The agent may install from the BrowserBox index with the usual command
permission; installing from any other source always asks the person (the
same "only a person" rule as profile commands), so a model cannot pull in
arbitrary code.

### 3.5 Operations

| Command | Does |
|---|---|
| `pkg search <words>` | search every source by id, summary and command names |
| `pkg list [--installed]` | packages, installed or not, with sizes |
| `pkg info <id>` | version, kind, source, license, files, commands, depends |
| `pkg install <id>[@version]…` | with dependencies; progress per file; checks sha256 |
| `pkg remove <id>…` | removes its files and commands; refuses while another package depends on it (`--force` to remove anyway) |
| `pkg update` | refresh the indexes |
| `pkg upgrade [id…]` | newer versions of installed packages |
| `pkg files <id>` | what it installed |
| `pkg verify [id…]` | re-check every cached file's sha256 |
| `pkg source list | add <url> | remove <url>` | where packages come from |
| `pkg why <command>` | which package provides a command |

Installed state moves from a list of ids to records:
`{ id, version, kind, source, files, commands, installedAt }` in the setting
`pkg.installed` (old lists are read as builtin installs).

### 3.6 Terminal integration

- Tab completion: `pkg` verbs, package ids (installed ones for `remove`,
  `upgrade`, `files`; all for `install`, `info`), and commands from installed
  packages everywhere.
- A command from a package that is not installed says which package has it,
  with the exact `pkg install` line (as today, for every kind).
- `help` lists package commands under their package.
- A per-user `bin` folder: executable scripts in `~/.local/bin` (`.sh`,
  `.js`, `.wasm`) are commands without packaging them (the `script` kind for
  one's own tools).

### 3.7 The first catalog (each file verified and pinned before it is listed)

Candidates, to be checked for a working WASI or browser build and licence:
jq, Lua, QuickJS, uutils coreutils (selected tools), SQLite's own CLI,
prettier, marked, js-yaml, TypeScript (tsc), cowsay; later clang/wasi-sdk
(large, but it lets the agent compile C to WASM in the box).

### 3.8 Tests

Unit: manifest validation, sha256 refusal, dependency order, remove refusal,
upgrade, index merging, WASI file calls (open/read/write/readdir/stat/rename
on the memory filesystem). Browser: install a small WASM package from a local
test index, run it on a file, remove it; install a JS package and run it;
Tab completion of `pkg i<Tab>` and of package ids; the agent asking to
install from an unknown source is refused.

---

## 4. The browser platform: what is used

The runtime detects about forty platform features (System → Capabilities).
Fewer than half are used, and the capability list names uses for some that
do not exist yet.

| Feature | Status | Note |
|---|---|---|
| WebAssembly, Workers, OPFS, IndexedDB, Cache Storage, Service Worker, Web Locks, BroadcastChannel, Web Crypto, Compression Streams, Clipboard, Wake Lock, Speech synthesis, Speech recognition, WebGPU, File System Access, Persistent storage, Fullscreen | **Used** | |
| Notifications | **Partly**: agent finished in a background tab, scheduled tasks | Not for approvals waiting, or questions the agent asks while you are away |
| Web Share | Detected only (list says "Share files") | |
| Screen Capture | Detected only (list says "Screenshots") | |
| WebRTC, WebTransport, WebSocket (for the agent) | Detected only | |
| WebCodecs, Web Audio, OffscreenCanvas | Detected only | |
| WebUSB, Web Serial, Web Bluetooth, WebHID, Gamepad | Detected only | |
| Built-in Prompt API (on-device model), WebNN | Detected only | |
| Badging, File Handling, Share Target, Protocol handlers, Document Picture-in-Picture, Passkeys (WebAuthn), MediaRecorder, Periodic Background Sync, Idle Detection | Not detected or used | |

### 4.1 Proposed uses, most valuable first

1. **Honest capability list**: show "used for …" only for what is used,
   and "available" for the rest (a small fix; do it first).
2. **Notifications, completed**: an approval or a question waiting while
   the tab is hidden; a scheduled task finished (done); a long build finished.
   Clicking one focuses the right window and chat.
3. **Screen capture → the agent sees your screen**: "Share a screen" in the
   message box (getDisplayMedia): one frame becomes an image attachment
   (image input already works). Never continuous, always the user's choice.
4. **Passkeys to unlock a profile** (WebAuthn with the PRF extension): sign
   in with the device's fingerprint or face instead of a password; the PRF
   output wraps the profile's key, like the password does today.
5. **Built-in on-device model** (Chrome's Prompt API, `LanguageModel`): a
   fourth model source, "Built into this browser": no download, no key,
   offline, where the browser has it.
6. **Install as an app, properly**: manifest `file_handlers` (open files
   from the computer into BrowserBox), `share_target` (share text or files
   from other apps to the agent), the **Badging API** (number of chats waiting
   for you on the app icon), `launchQueue`.
7. **Web Share**: share an artifact or file to other apps from its menu.
8. **Document Picture-in-Picture**: a small always-on-top window showing
   what the agent is doing while you work elsewhere.
9. **Voice notes** (MediaRecorder): record audio into the box; transcription
   where speech recognition exists.
10. **Later, larger**: WebRTC peer-to-peer (sync a profile or share a box
    between two devices without a server); WebUSB/Serial for hardware tools
    (flash a microcontroller from the agent); Periodic Background Sync for
    installed apps (occasional scheduled runs with no tab open, on Chromium).

---

## 5. Order of work and versions

1. Runtime 0.5: WASI filesystem; package format, sources, sha256,
   dependencies, the operations in 3.5, Tab completion, `~/.local/bin`; the
   first verified catalog; the honest capability list.
2. App 0.5: Settings → Packages (search, install, remove, sources), the
   platform features 4.1 items 2–7.
3. Agent: knows about `pkg search` and installs from the index; refused
   for other sources.

## 6. Decisions needed

1. **Trust**: curated index without asking, other sources asking once per
   source, one-off URLs asking every time, and the agent limited to the
   curated index. Agree?
2. **Hosting the catalog's files**: link to upstream release URLs (pinned by
   sha256), or mirror them into this repository's releases (more reliable,
   more storage, licences to respect)?
3. **JS packages**: a small curated set adapted to run in the browser, or a
   general "any npm CLI" attempt that will fail for many (sync filesystem,
   native modules, child processes)?
4. **Which platform features first** from 4.1 (proposed: 1, 2, 3, 4, 5).
