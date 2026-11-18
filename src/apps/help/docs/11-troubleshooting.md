# Troubleshooting

## "Could not reach …" / "did not accept a request from this page"

Browsers only let a web page call servers that allow it (CORS). This is the server's choice, not something BrowserBox can switch off.

- **Local server**: start it so it allows this page (for Ollama: `OLLAMA_ORIGINS="*" ollama serve`). Recent Chrome may ask to let the site access devices on your network: allow it.
- **ollama.com**: use a local Ollama signed in to your account (`-cloud` models), or set a relay.
- **Websites the agent fetches**: most do not allow it. With Claude, the agent's web search and fetch run server-side and are not limited.

## The in-browser model is slow or fails to load

It needs WebGPU (Chrome, Edge, or Safari with WebGPU) and enough GPU memory: pick a smaller model. The first message after choosing a model loads it, which takes a while.

## Pop-ups are blocked

Opening the desktop or a new tab needs your browser to allow pop-ups for this site.

## Sandboxes or previews do not load

If cross-origin isolation is on and you use Firefox, turn it off (Settings → Environment).

## Storage is full

Settings → Data shows how much space BrowserBox uses. Downloaded models (delete them in Settings → Model) and installed packages (`pkg remove`) are the largest; large files you no longer need can go from Files.

## Start again

Settings → Data → Reset settings puts the settings back to their defaults. To remove everything (files, chats, keys), clear this site's data in your browser's settings.
