# @jeevanand/browserbox

A sandboxed computer for AI agents, inside the browser. No backend, no VM, no special headers on your site.

`BrowserBox.boot()` gives your page a box with a filesystem, a shell (~100 commands, pipes, redirects), Python with pip, git, sqlite, a package manager, real Node.js where the page is cross-origin isolated, and an AI agent that uses all of it. It is the same idea as WebContainers, built for agents.

```sh
npm install @jeevanand/browserbox
```

```js
import { BrowserBox } from '@jeevanand/browserbox';

const box = await BrowserBox.boot();

// Files (relative paths are under /home/agent, the agent's workspace)
await box.mount({
  'data.csv': { file: { contents: 'name,score\nada,9\nlin,7\n' } },
  src: { directory: { 'main.py': { file: { contents: 'print(open("data.csv").read())' } } } },
});
await box.fs.writeFile('notes.md', '# Notes');
const text = await box.fs.readFile('notes.md', 'utf8');

// Commands
const { exitCode, stdout } = await box.exec('cat data.csv | grep ada');

// Streaming output
const proc = await box.spawn('pkg', ['install', 'python']);
proc.output.pipeTo(new WritableStream({ write: (chunk) => console.log(chunk) }));
await proc.exit;

// The agent
await box.agent.configure({ provider: 'anthropic', apiKey: 'sk-ant-…' });
const chat = await box.agent.create();
chat.on((e) => e.type === 'tool_start' && console.log('▶', e.summary));
const answer = await chat.send('Load data.csv with Python and tell me the average score');

// Show the agent app (or 'desktop', 'docs') in your page, on the same files
box.ui(document.querySelector('#panel'), 'agent');
```

## How it works

`boot()` adds a hidden iframe that loads the BrowserBox runtime from `https://jeevanandmaurya.github.io/agent-browserbox/embed/`. The kernel, its WebAssembly and the packages run there. This package is only the client: about 4 KB gzipped, with no dependencies. It talks to the runtime over a `MessagePort`.

- **Storage**: browsers partition storage by the site that embeds a frame. Your site gets its own box, and its files persist between visits (`box.info.storage === 'opfs'`). It never sees the files or keys of people who use BrowserBox directly, or of other sites.
- **Isolation**: your page needs no COOP/COEP headers. To use real Node.js (WebContainers) or SharedArrayBuffer in the box, make your page cross-origin isolated. The frame is created with `allow="cross-origin-isolated"`. Check `box.info.isolated`.
- **Self-hosting**: build the repository (`npm run build`) or use `npx @jeevanand/browserbox-app --dir`. Serve that folder, then `BrowserBox.boot({ runtimeUrl: 'https://your-host/embed/' })`. If your app is on the same site as the runtime, build with `VITE_ALLOWED_ORIGINS=https://your-app`: same-site frames share storage, so the runtime only serves pages you list.

## API

| | |
|---|---|
| `BrowserBox.boot(opts?)` | `runtimeUrl`, `timeout`, `onPermission(req)` (default: allow; return `'once' \| 'always' \| 'deny'`), `onQuestion(q, options)` |
| `box.info` | `{ version, storage, isolated, caps, home, protocol }` |
| `box.fs` | `readFile(path, 'utf8'?)`, `writeFile` (creates folders), `appendFile`, `readdir`, `stat`, `exists`, `mkdir(path, { recursive })`, `rm(path, { recursive, force })`, `rename`, `cp`, `glob(pattern, cwd?)` |
| `box.mount(tree, { mountPoint })` | WebContainer-format file tree; resolves with the number of files |
| `box.spawn(cmd, args?, { cwd })` | `{ output: ReadableStream<string>, exit: Promise<number>, write(text), kill() }` |
| `box.exec(cmdline, { cwd })` | `{ exitCode, stdout, stderr }` |
| `box.agent.configure(cfg)` | `{ provider: 'anthropic' \| 'openai' \| 'local' \| 'webllm', model, apiKey, baseUrl, mode: 'auto' \| 'ask' }` |
| `box.agent.create({ private })` | a session: `send(text, { plan })` → final text, `on(fn)` events, `stop()`, `messages()`, `dispose()` |
| `box.ui(element, view)` | an iframe with `'agent'`, `'desktop'` or `'docs'` |
| `box.teardown()` | stops what this client started and removes the frame (files stay) |

Errors are `BoxError`s; filesystem errors have a `code` such as `ENOENT`.

Full documentation: https://jeevanandmaurya.github.io/agent-browserbox/docs/#sdk · MIT licence.
