# For developers: the SDK

Put a BrowserBox inside your own web app. Your app gets a sandboxed computer with files, a shell, Python, packages and an agent, all running in the user's browser. You don't need a server.

```sh
npm install @jeevanand/browserbox
```

```js
import { BrowserBox } from '@jeevanand/browserbox';

const box = await BrowserBox.boot();
await box.fs.writeFile('main.py', 'print(6 * 7)');
const { stdout } = await box.exec('pkg install python && python main.py');
```

## What you can do

- **Files**: `box.fs.readFile`, `writeFile`, `readdir`, `mkdir`, `rm`, `rename`, `glob`. `box.mount(tree)` writes a whole project at once. Relative paths are under `/home/agent`, the agent's workspace.
- **Commands**: `box.exec('…')` collects the output. `box.spawn('npm', ['install'])` streams it, and gives you `exit`, `kill()` and `write()` for input.
- **The agent**: `box.agent.configure({ provider, apiKey, model })`, then `const chat = await box.agent.create()` and `await chat.send('…')`. `chat.on(fn)` streams what it does: text, tool calls, file changes.
- **Its windows**: `box.ui(element, 'agent' | 'desktop' | 'docs')` shows the BrowserBox app in your page, working on the same files.

## How it works

`boot()` loads the runtime (this site's `/embed/` page) in a hidden frame. The SDK itself is a few KB and talks to the runtime through messages, so your page needs no special headers.

Each site that embeds BrowserBox gets **its own box**, because browsers partition a frame's storage by the site around it. Your users' files persist between visits. Your app can't see what they keep in BrowserBox itself, and other sites can't see yours.

Real Node.js and SharedArrayBuffer need cross-origin isolation. To use them, serve your page with COOP/COEP headers. `box.info.isolated` tells you whether the box has it.

## Permissions and questions

By default the agent may do anything inside the box, since that is what the sandbox is for. To decide yourself, pass `onPermission: (req) => 'once' | 'always' | 'deny'` to `boot()`. To let your users answer the agent's questions, pass `onQuestion`.

## Hosting the runtime yourself

Build this repository, or run `npx @jeevanand/browserbox-app --dir` to get the built site. Host the folder, then call `BrowserBox.boot({ runtimeUrl: 'https://your-host/embed/' })`. If your app and the runtime are on the same site, build with `VITE_ALLOWED_ORIGINS=https://your-app`: they would share storage, so the runtime serves only the pages you list.

## Running the app

To run the whole BrowserBox app on your computer, use `npx @jeevanand/browserbox-app`. See [Advanced](advanced).
