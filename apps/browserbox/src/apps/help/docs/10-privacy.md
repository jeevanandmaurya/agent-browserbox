# Privacy and security

## What stays on your device

Your files, chats, settings and installed packages live in this browser's storage (the Origin Private File System, IndexedDB and Cache Storage). They are not uploaded anywhere. Settings → Data shows how much space they use and can export or reset your settings. Clearing this site's data in your browser removes everything.

## Profiles and signing out

Several people can use BrowserBox in the same browser with **profiles**: each has its own files, settings, API keys and chats. Switch with your name at the bottom of the sidebar, or in **Settings → Profile**, which also creates, renames and deletes profiles.

A profile can have a **password**. Signing out then locks its API keys and tokens: nobody can use them (nor the agent with them) until the password is entered again. You stay signed in, even after closing the browser, until you sign out. Files are not encrypted, so someone with access to this browser's developer tools could still read them. A forgotten password cannot be recovered; delete the keys and save them again.

With a password set, you can add **passkeys** (Settings → Profile → Passkeys) and sign in with your fingerprint, face, phone or security key instead. The passkey's secret (WebAuthn PRF) unlocks the keys the same way the password does, and never leaves your device. Changing or removing the password removes the passkeys; add them again.

## What leaves your device

- **Model requests** go to the model you chose: a hosted API (Anthropic, OpenAI, OpenRouter…), your local server, or nowhere (in-browser models).
- **Network tools** the agent uses with your permission (fetching a URL, searching, installing packages).
- **Publishing** you ask for: GitHub, Netlify, Vercel.
- **Downloads**: packages from jsDelivr, npm packages from esm.sh and npm, Python packages from PyPI, and models from Hugging Face.

## Keys and tokens

API keys and tokens are stored encrypted. BrowserBox's windows can save or remove them but never read them back; only the kernel uses them, and each is sent only to its own service.

## Sandboxes

Code the agent runs (JavaScript, Python, WebAssembly, previews of the pages it builds) runs in sandboxed frames with an opaque origin: it cannot see BrowserBox's storage, keys, cookies or the sites you are signed in to. JavaScript sandboxes have no network unless you allow it.

## Permissions

In **Ask first** mode the agent asks before changing files outside its folder, running code or using the network. Settings → Permissions shows and revokes standing permissions.
