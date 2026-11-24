# @jeevanand/agent-browserbox-sdk

A sandboxed computer in the browser, for AI agents and anything else that
must run untrusted code: a filesystem, a shell, and JavaScript, Python and
WebAssembly runtimes. It runs entirely on the user's device, with no backend
and no VM service, isolated in its own origin.

The SDK is 3 kB (gzip) with no dependencies. The runtime it drives is loaded
in a hidden frame from another origin, so your page needs no special headers
and nothing in the box can touch your page.

```sh
npm install @jeevanand/agent-browserbox-sdk
```

```ts
import { BrowserBox } from '@jeevanand/agent-browserbox-sdk';

const box = await BrowserBox.boot();

await box.fs.writeFile('main.js', 'print(6 * 7)');
const { exitCode, stdout } = await box.exec('js main.js'); // 0, "42\n"

const p = await box.spawn('echo building && sleep 1 && echo done');
for await (const chunk of p.output) console.log(chunk); // as it happens
await p.exit; // 0

box.teardown();
```

## API

### `BrowserBox.boot(options?)`

| Option | Default | |
|---|---|---|
| `id` | `'default'` (a fresh id for in-memory boxes) | Which box. Each id is a separate machine with its own files, settings and processes. Booting the same id again, e.g. after a reload, reattaches to its files. Letters, digits, `-` and `_`. |
| `storage` | `'persistent'` | `'persistent'`: files survive reloads. `'memory'`: nothing is written to disk, and everything is gone when the box is torn down. |
| `runtimeUrl` | the hosted runtime | Base URL of the runtime. Self-host it with [`@jeevanand/agent-browserbox-runtime`](../runtime). |
| `permissions` | `'deny'` | What to answer when code in the box asks for a capability (today: network access from `curl` and `js --net`). `'deny'`, `'allow'`, or `(request) => 'once' \| 'always' \| 'deny'`. |
| `container` | `document.body` | Where the hidden frame goes. |
| `timeoutMs` | `30000` | Give up booting after this long. |

The box has `id`, `version`, `home` (the default working directory), `caps`
(platform features available) and `storage` (`'opfs'`: files persist across
reloads, `'memory'`: they do not).

```ts
// One throwaway machine per agent task:
const box = await BrowserBox.boot({ storage: 'memory' });
// A project that should still be there tomorrow:
const project = await BrowserBox.boot({ id: 'my-project' });
```

### Files: `box.fs`

`readFile(path)` → `Uint8Array` · `readTextFile(path)` · `writeFile(path, string | Uint8Array)` ·
`mkdir(path)` · `readdir(path)` → `FileStat[]` · `stat(path)` → `FileStat | null` ·
`exists(path)` · `rm(path, { recursive })` · `rename(from, to)` · `cp(from, to)`

Relative paths resolve against `box.home`. Parent folders are created as needed.
Errors are `BoxError`s with a `code` (`ENOENT`, `EEXIST`, `ENOTDIR`, …).

### Commands

- `box.exec(command, { cwd, env, timeoutMs })` → `{ exitCode, stdout, stderr }`
- `box.spawn(command, { cwd, env, timeoutMs })` → a process with `output`,
  `stdout` and `stderr` (`ReadableStream<string>`), `exit` (a promise of the exit
  code) and `kill()`.

Exit code 124 means the command timed out, 130 that it was killed. Output is
plain text: colour codes are removed, and `exec` collapses progress bars
(lines redrawn with `\r`) to their final state.

Commands run in BrowserBox's shell (`help` lists them): files and text (`ls`,
`cat`, `grep`, `find`, `sort`, …), `js` (JavaScript in a sandboxed worker),
`wasm` (WASI programs), `curl`, `gzip`, `npm` (records dependencies; packages
load from esm.sh), `serial` (Web Serial devices, through a window) and `pkg`:
`pkg install python|git|sqlite|zip|esbuild`, and WASM, JavaScript and script
packages from package indexes (`pkg search`; the official index has quickjs,
ripgrep, prettier, marked and yaml).
It is not bash, and there is no Node.js.

### Shell sessions

```ts
const sh = await box.openShell({ cwd: 'project' });
await sh.exec('cd src && export MODE=dev');
await sh.exec('pwd && echo $MODE'); // "…/project/src", "dev"; sh.cwd follows
```

`sh.run(command)` streams like `box.spawn()`. One command at a time per session.

### More

- `box.fs.glob('**/*.ts', { cwd })` → absolute paths · `box.fs.appendFile(path, data)`
- `box.dev.start('site')` → `{ port, url, root }` · `box.dev.logs(port)` · `box.dev.list()` · `box.dev.stop(port)`
- `box.processes()` → the process table · `box.killProcess(pid)`
- `box.share()` → a port for a worker, which calls `BrowserBox.attach(port)` (its own shells, processes and permission answers)
- `BrowserBox.boot({ site: true })` → the site's own kernel (the one a BrowserBox app on this site uses) instead of a box; `{ site: true, profile: id }` → one of the site's profiles
- `box.kernelPort()` → a channel to the kernel's full internal protocol, for app UIs; versioned with the runtime

### `box.teardown()`

Removes the frame and fails any call still pending.

## Isolation, and what to know

- **The box runs on the runtime's origin**, in a frame with no access to your
  page, and your page has no access to it except through this API. Code inside
  runs in further sandboxed frames and workers with an opaque origin.
- **Network access needs permission.** `curl` and `js --net` ask, and the
  answer comes from your `permissions` option (deny by default). Installing
  packages (`pkg`, `npm`) fetches from fixed registries without asking.
- **Every box is a separate machine.** Each id has its own kernel, files,
  settings and permission grants; boxes never see each other's files.
- **Storage is per embedding site.** Browsers partition a cross-site frame's
  storage by the top-level site, so your boxes never see another site's, even
  with the same id.

## Self-hosting

The default runtime is hosted on GitHub Pages. To serve it yourself:

```sh
npx @jeevanand/agent-browserbox-runtime      # http://127.0.0.1:4180/
```

or copy its files into your site (`npx @jeevanand/agent-browserbox-runtime --dir`
prints where they are) and pass that URL as `runtimeUrl`. Use the same version
of the SDK and the runtime.

## License

MIT
