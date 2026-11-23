# Changelog

Covers both `@jeevanand/agent-browserbox-sdk` (the SDK) and
`@jeevanand/agent-browserbox-runtime` (the runtime), which are always released
together with the same version. Each section becomes the "What's new" part of
the GitHub release notes.

## 0.2.1

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
