# About BrowserBox

BrowserBox is an AI agent with a computer of its own, running entirely in a browser tab. There is nothing to install and no server behind it: the agent's files, terminal, code sandboxes and tools all live in your browser, on your device.

Ask it for something and it works the way a developer would: it writes files, runs code, installs packages, starts a dev server, reads the console to fix its own mistakes, and can push the result to GitHub or deploy it as a live website.

## What it is good for

- **Building and shipping small web apps from anywhere**, including a phone or a locked-down laptop: describe it, watch it run in Preview, then [deploy](shipping) it.
- **A safe place to let an agent act.** Everything happens in a sandbox inside the tab. It cannot reach your real computer, your passwords or the sites you are signed in to. You can review every change as a diff and undo it.
- **Private and offline AI.** With a model running [in the browser](models) or on your own machine, nothing leaves your device.
- **Working with data**: drop in a file and have it analysed with Python, SQLite or JavaScript.
- **Learning to code** with a terminal, Python, Node.js, git and an AI tutor from a single link.

## How it works

- **The kernel** runs in the background (a shared worker). It owns the [file system](privacy), the processes, the shell and the agents. Closing a window does not stop it while another BrowserBox window is open.
- **Windows** are just views onto the kernel: the agent window you are probably in now, and an optional [desktop](desktop). Both see the same files and chats.
- **Code runs in sandboxes**: separate frames with no access to BrowserBox's storage or keys, and no network unless you allow it.
- **Models** are your choice: Claude, a server on your machine, a hosted API, or a small model running on your GPU in this tab. See [Models](models).

## Not a good fit

Large repositories, heavy builds, Docker, databases or long-running servers still need a real machine. Browsers also limit which websites a page may talk to (see [Troubleshooting](troubleshooting)).

## Open source

BrowserBox is open source. It is built with TypeScript and Vite, a Rust core compiled to WebAssembly, and these libraries and services, under their own licences: the Anthropic SDK, WebLLM (in-browser models), Pyodide (Python), esbuild (bundling), isomorphic-git, sql.js, fflate, and StackBlitz WebContainers for the optional real Node.js.
