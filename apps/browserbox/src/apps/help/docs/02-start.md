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

BrowserBox can be installed like an app (Chrome: the install icon in the address bar; Safari on iPhone: Share → Add to Home Screen). It then opens in its own window and starts offline.
