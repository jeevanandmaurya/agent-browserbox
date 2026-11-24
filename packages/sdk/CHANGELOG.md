# Changelog

Covers both `@jeevanand/agent-browserbox-sdk` (the SDK) and
`@jeevanand/agent-browserbox-runtime` (the runtime), which are always released
together with the same version. Each section becomes the "What's new" part of
the GitHub release notes.

## 0.4.3 (not released yet)

- Runtime: JavaScript packages can have binary files (`commands.*.assets`),
  read with `await asset(path)`; such commands may run 10 minutes. `require`
  is declared (empty) while a package's libraries load, so `typeof require`
  checks work. Five packages in the index: sheet, pdf, docx, ffmpeg, ocr.

- Runtime: the Python runtime's scripts lose their source map links when run
  from the cache, so developer tools no longer log a CSP error for
  `pyodide.js.map`.

## 0.4.2

- **Overlay folders**: `box.fs.overlay(point, lower, store)` mounts a
  copy-on-write view of a folder: reads see the folder, writes and deletes are
  kept in `store` (surviving reloads; mount it again after one), so the folder
  is untouched. `overlayChanges(point)` lists added, modified and deleted
  files; `overlayApply(point, paths?)` copies them into the folder;
  `overlayDiscard(point, paths?)` throws them away. In the kernel: `fs.overlay`
  and friends, and `OverlayFs`.

## 0.4.1

- **`help` in sections**, with installed package commands and `~/.local/bin`
  commands; `help <section>`; descriptions wrap under themselves.
- `Command.section` and `ContributedCommand.section`: where `help` lists a
  command. Contributed commands get `interactive` (a person is typing).

## 0.4.0

- **Accept-edits permission mode**: `PermMode` is `'ask' | 'edits' | 'auto'`.
  The runtime treats `edits` like `ask` for its own checks (commands such as
  `curl` and `js --net` still ask); the agent lets its file changes through.
  A mode the runtime does not know is treated as `ask`.
- **Package manager v2**: besides the built-in packages, `pkg` installs
  WASM (WASI), JavaScript and shell-script packages described by
  `bbx-package.json`, from package indexes (`pkg source add|remove|list`)
  or one URL. Every file is checked against its sha256; dependencies
  (`id>=version`) install first; `remove` refuses while something depends
  on it. New verbs: `search`, `info`, `update`, `upgrade`, `files`,
  `verify`, `why`. Installs from a non-official index or URL ask, and only
  a person at a terminal can confirm. Tab completes `pkg` verbs and ids.
- **Your own commands**: files in `~/.local/bin` (`name`, `.wasm`, `.js`,
  `.sh`) run by name.
- **WASI programs see files**: `wasm` / `runWasm({cwd})` give the program the
  working folder (preopened as `.` and its absolute path), with read, write,
  seek, mkdir, rename, delete, readdir and stat; changes are written back.
  Paths outside it are refused. `PWD` and the user's variables are set.
- **The official package index** has its first packages, each file pinned
  by sha256 to its upstream build on jsDelivr and tested in the app:
  quickjs (`qjs`), ripgrep (`rg`), prettier, marked, and yaml (`yaml2json`,
  `json2yaml`). The format and how to add one: `packages/runtime/catalog/`.
- **JavaScript packages**: a file can be inline `text` (a wrapper kept in
  the index), and a command can `load` library files first, which the
  program gets with `require(path)` (UMD and CommonJS builds work).
- **JavaScript programs** (`js`, packages, `~/.local/bin`) get `stdin` and
  `exit(code)`.
- **Passkeys unlock a profile**: `secrets.passkeys()`, `addPasskey()`,
  `unlockWithPasskey()`, `removePasskey()` (optional on `SecretsApi`). A
  window runs WebAuthn with the PRF extension; the kernel derives a key from
  the PRF output (HKDF) that wraps the data key, beside the password.
  `setPassword` removes passkeys (the data key changes).
- **Capabilities**: `PlatformCap.used` says whether BrowserBox uses a
  feature; `use` is empty when it does not. Uses that did not exist are gone,
  and passkeys, App badge, File Handling, Document Picture-in-Picture, Idle
  Detection and MediaRecorder are detected.
- **`Kernel.pkg`** (optional, windows only): the package manager for a
  person's UI: `builtin`, `index`, `installed`, `install`, `describeUrl`,
  `installFrom`, `remove`, `dependents`, `upgradable`, `verify`, `sources`,
  `addSource`, `removeSource`. Package types moved to `package-types`.
- **`serial` command** and `SerialHost` (Web Serial): list, open, send, read,
  monitor, close; the kernel reaches devices through a window
  (`serial.*` UI calls; `RemoteKernel.serial`). SDK (confined) shells ask
  before using a device.
- Fixed: `serial` reading on the first open.
- Fixed: Python saw files from earlier runs (its interpreter stays warm):
  each run now starts from exactly its folder, and files a script deletes
  are deleted in the box.
- Fixed: an install's progress counted wrapper files that are not
  downloaded, so it stopped at 99%.

## 0.3.1

New, all backward compatible:

- **Terminal commands for profiles**: `profile` (show, `list`, `new`,
  `switch`, `rename`, `delete`), `passwd`, `signout`/`logout`, and `exit`.
  Only a person at a terminal can change profiles: a shell counts as one once
  a window shows it in a terminal (`onReadLine`); the agent's and SDK shells
  never do.
- **Terminal actions**: `ShellHandle.onAction` tells the window showing a
  terminal what a command asks of it (`exit`, open another profile).

## 0.3.0

New, all backward compatible:

- **Profiles**: `BrowserBox.boot({ site: true, profile })` drives one of the
  site's profiles, each a kernel of its own (files, settings, keys). The
  runtime's client manages the list (`listProfiles`, `createProfile`,
  `updateProfile`, `deleteProfile`, `lastProfile`). The first profile keeps
  the site's existing data and no longer sees other profiles' or boxes' folders.
- **Password-locked keys**: `secrets.setPassword()`, `status()`, `lock()` and
  `unlock()` on the kernel client. With a password, signing out locks the
  saved keys until the password is entered again; every window of the profile
  hears it (`secrets:lock`).
- The welcome file a new BrowserBox site writes lists every kind of model,
  not just Claude.

## 0.2.0

New, all backward compatible:

- **Shell sessions**: `box.openShell({ cwd, env })` keeps its working folder
  and variables between commands, like a terminal; `shell.exec()` and
  `shell.run()` (streaming), `shell.cwd`, `shell.close()`.
- **Files**: `box.fs.glob(pattern, { cwd, limit })` and `box.fs.appendFile()`.
- **Dev servers**: `box.dev.start(folder)`, `stop`, `list` and `logs` (console
  output, server logs, build errors and failed requests).
- **Processes**: `box.processes()` lists the box's process table, and
  `box.killProcess(pid)` stops one.
- **Workers**: `box.share()` gives a second connection (its own shells,
  processes and permission answers) to hand to a worker, which connects with
  `BrowserBox.attach(port)`.
- **The site's own kernel**: `BrowserBox.boot({ site: true })` drives the
  kernel a BrowserBox app on the same site uses, with its files, settings and
  keys, instead of a separate box.
- **Kernel channel**: `box.kernelPort()` for app UIs that need the kernel's
  full internal protocol (versioned with the runtime; pin the runtime).
- **Runtime client**: `@jeevanand/agent-browserbox-runtime/client` exports
  `RemoteKernel` and the kernel's types, for apps that drive the kernel over
  `box.kernelPort()`. It contains no kernel code.
- The runtime no longer contains the BrowserBox app's agent (1.3 MB instead
  of 7.6 MB); `build` is a runtime shell command.

## 0.1.1

- **The SDK now uses the hosted runtime of its own exact version** by default
  (`…/runtime/0.1.1/`). Released runtimes never change, so a later runtime
  release can never break an app built on this SDK. `VERSION` is exported.
- The SDK package is now `@jeevanand/agent-browserbox-sdk` (it was briefly
  published as `@jeevanand/agent-browserbox`, which will be the agent).
- The runtime reports its real version.

## 0.1.0

First release.

- `BrowserBox.boot()` starts a sandboxed machine in a hidden frame on the
  runtime's own origin. The embedding page needs no special headers.
- **Separate boxes**: each `id` has its own kernel, files, settings and
  permission grants. `storage: 'memory'` gives a throwaway box that writes
  nothing to disk.
- **Files**: `box.fs.readFile`, `readTextFile`, `writeFile`, `mkdir`, `readdir`,
  `stat`, `exists`, `rm`, `rename`, `cp`. Errors carry codes such as `ENOENT`.
- **Commands**: `box.exec()` returns plain-text output and an exit code;
  `box.spawn()` streams output and supports `kill()`. Options: `cwd`, `env`,
  `timeoutMs`. Includes JavaScript (`js`), WebAssembly (`wasm`) and installable
  packages (Python, git, SQLite, zip, esbuild).
- **Network permission**: `curl` and `js --net` ask the embedding page first,
  through the `permissions` option. The default is deny.
- **Self-hosting**: `npx @jeevanand/agent-browserbox-runtime` serves the
  runtime, or unzip the release's runtime zip onto any static host.
