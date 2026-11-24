# Packages: the format and the official catalog

`pkg` installs two kinds of packages:

- **Built-in packages** (python, git, sqlite, zip, esbuild, node): built into the
  runtime, listed by `pkg list`.
- **Packages from an index**: WebAssembly (WASI) programs, JavaScript programs
  and shell scripts, each described by a `bbx-package.json`. The official index
  is `public/kernel/package-index.json`, built from `catalog.json` here; anyone
  can host another (`pkg source add <url>`).

## A package

```json
{
  "id": "marked",
  "version": "18.3.0",
  "kind": "js",
  "summary": "Markdown to HTML",
  "license": "MIT",
  "homepage": "https://marked.js.org",
  "files": [
    { "path": "lib/marked.umd.js", "url": "https://cdn.jsdelivr.net/npm/marked@18.3.0/lib/marked.umd.js", "sha256": "…", "bytes": 55534 },
    { "path": "marked.js", "text": "const { marked } = require('lib/marked.umd.js'); …", "sha256": "…" }
  ],
  "commands": { "marked": { "run": "marked.js", "load": ["lib/marked.umd.js"] } },
  "depends": ["other-package>=1.2"]
}
```

| Field | |
| --- | --- |
| `id` | lowercase letters, digits, `.` `_` `-` |
| `kind` | `wasm` (WASI preview 1), `js` or `script` |
| `files` | each with a `url` (any https host that allows CORS) or inline `text`, and always its `sha256`. A file that does not match is not installed |
| `commands` | command name → `run` (one of the files), optional fixed `args`, and for `js`, `load`: libraries run first, and `assets`: binary files (WebAssembly, data) the program reads with `await asset(path)` |
| `depends` | other packages, `id` or `id>=version`, installed first |

An index is `{ "packages": [ … ] }`. A single package can also be installed
from the URL of its `bbx-package.json` (`pkg install https://…`); that asks
every time.

### What programs get

- **wasm**: WASI preview 1. Arguments, environment (`PWD`, your variables),
  stdin, clocks, random, and the folder it runs in (preopened as `.` and as its
  absolute path): read, write, seek, mkdir, rename, delete, readdir, stat.
  Paths above that folder are refused. No sockets, threads or `poll_oneoff`.
  Imports outside `wasi_snapshot_preview1` get a stub that fails, so a program
  built for Emscripten or a WASIX host will not run.
- **js**: runs as the body of an async function with `fs` (paths relative to
  the folder: `readText`, `readFile`, `writeFile`, `appendFile`, `readdir`,
  `exists`, `mkdir`, `rm`, `glob`), `console`, `print`, `args`, `env`,
  `stdin` (piped input, as text), `exit(code)` and, with `load`, `require(path)`.
  Each loaded library gets its own `module`/`exports`, so UMD and CommonJS
  builds work (`require` is defined, but empty, while they load). With
  `assets`, `asset(path)` gives a binary file of the package as a Uint8Array,
  e.g. an Emscripten build's `.wasm` passed as `wasmBinary`; such a command
  may run for 10 minutes instead of 2. No network.
- **script**: shell lines run in the calling shell; `$ARGS` holds the
  arguments.

## The official catalog

| Package | Commands | Source |
| --- | --- | --- |
| quickjs 0.18.0 | `qjs` | QuickJS-ng, WASI build from `@ai-ecoverse/wasi-quickjs` |
| ripgrep 15.2.0 | `rg` | WASI build from `@ai-ecoverse/wasi-ripgrep` |
| prettier 3.10.1 | `prettier` | `prettier` standalone + plugins |
| marked 18.3.0 | `marked` | `marked` UMD build |
| yaml 4.1.0 | `yaml2json`, `json2yaml` | `js-yaml` |
| sheet 0.18.5 | `sheet` | SheetJS (`xlsx`): Excel, OpenDocument, CSV, JSON |
| pdf 1.17.1 | `pdf` | `pdf-lib`, and `pdfjs-dist` 3 (legacy UMD build) for text |
| docx 1.11.0 | `docx` | `mammoth` browser build: Word to text, HTML, Markdown |
| ffmpeg 0.12.10 | `ffmpeg`, `ffprobe` | `@ffmpeg/core` (ffmpeg.wasm, one thread; GPL) |
| ocr 6.0.0 | `ocr` | `tesseract.js-core` (WebAssembly inside the script) and `@tesseract.js-data/eng` |

Every file is the upstream build, served by jsDelivr from npm, pinned by sha256.

### Adding a package

1. Find a build that fits "What programs get" (for WASI, check that its only
   imports are `wasi_snapshot_preview1`).
2. Add it to `catalog.json`, with a wrapper in `wrappers/` for a JavaScript
   library.
3. `npm run catalog` downloads every file and writes the index with its
   sha256 and size. `node scripts/catalog.mjs --check` fails if an upstream
   file changed since it was pinned.
4. Add its commands to `scripts/catalog-test.mjs`, then
   `npm run build && npm run test:catalog` installs every package in the app
   and runs them on real files.

Tried and left out for now: Lua (`rainsi-lua`; it needs Emscripten-style
setjmp/longjmp imports), Ruby (`@ruby/*-wasm-wasi`; a library for its own
JavaScript API, not a command), TypeScript's WASI build (`tsc.wasm`, 52 MB,
Go, needs its lib files beside it), and the `@ai-ecoverse/wasm-*` tools such as
jq, sqlite3 and coreutils (built for their own kernel's ABI).
