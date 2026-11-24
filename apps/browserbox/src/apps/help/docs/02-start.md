# Getting started

## First start

The first time BrowserBox opens, it shows its start-up log and asks three things, all optional (press Enter to skip):

1. **Your name**, for the greeting.
2. **An API key** for a hosted model (Anthropic, OpenAI, OpenRouter…). It is stored encrypted in this browser.
3. If you skip the key: **the address of a model server** on your machine, such as Ollama.

You can change any of it later in **Settings → Model**, or run `setup` again in the Terminal.

## Your first tasks

Type a request in the message box and press Enter. Some ideas:

- "Make a page that shows a bar chart of this CSV" (attach the file with **+**)
- "Build a todo app with React and TypeScript, then show it to me"
- "Write a Python script that renames these photos by date"
- "Explain what this code does" with `@file.js` to include a file

The agent shows each step as it works: the tools it runs, the files it changes (as [diffs](agent)), and what it found. Small edits open their diff straight away.

## Where things are

- **☰ (top left)**: your chats. Several can run at once.
- **⋮ (top right)**: Files, Terminal, Preview, Browser, Processes, Changes, Context, Settings and this Help.
- **The side panel** (the panel icon) holds Files, Terminal, Preview and other tools beside the chat. On phones it is a sheet you drag up and down.
- **Under the message box**: **+** (attach, commands), the mode (Ask, Plan, Auto), the context gauge, and the model.

## Install it as an app

BrowserBox can be installed like an app (Chrome: the install icon in the address bar; Safari on iPhone: Share → Add to Home Screen). It then opens in its own window and starts offline. Installed, it also:

- **Opens files** from your computer: right-click a file → Open with → BrowserBox (text, code, Markdown, CSV, JSON, PDF, images, zip). The file is attached to a new message.
- **Takes things shared to it** from other apps (the share sheet on phones and some computers): text, links and files arrive in the message box.
- Shows on its icon **how many chats are waiting for you**, and has shortcuts (right-click the icon) for a new chat, the terminal and the desktop.
- Can **remind you of scheduled tasks** that are due while it is closed (Chrome and Edge; the browser decides how often it checks).
