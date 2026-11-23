# Privacy and security

## What stays on your device

Your files, chats, settings and installed packages live in this browser's storage (the Origin Private File System, IndexedDB and Cache Storage). They are not uploaded anywhere. Settings → Data shows how much space they use and can export or reset your settings. Clearing this site's data in your browser removes everything.

## What leaves your device

- **Model requests** go to the model you chose: Anthropic, your local server, a hosted API, or nowhere (in-browser models).
- **Network tools** the agent uses with your permission (fetching a URL, searching, installing packages).
- **Publishing** you ask for: GitHub, Netlify, Vercel.
- **Downloads**: packages from jsDelivr, npm packages from esm.sh and npm, Python packages from PyPI, and models from Hugging Face.

## Keys and tokens

API keys and tokens are stored encrypted. BrowserBox's windows can save or remove them but never read them back; only the kernel uses them, and each is sent only to its own service.

## Sandboxes

Code the agent runs (JavaScript, Python, WebAssembly, previews of the pages it builds) runs in sandboxed frames with an opaque origin: it cannot see BrowserBox's storage, keys, cookies or the sites you are signed in to. JavaScript sandboxes have no network unless you allow it.

## Permissions

In **Ask first** mode the agent asks before changing files outside its folder, running code or using the network. Settings → Permissions shows and revokes standing permissions.
