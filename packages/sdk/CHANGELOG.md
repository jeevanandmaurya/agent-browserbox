# Changelog

Covers both `@jeevanand/agent-browserbox-sdk` (the SDK) and
`@jeevanand/agent-browserbox-runtime` (the runtime), which are always released
together with the same version. Each section becomes the "What's new" part of
the GitHub release notes.

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
