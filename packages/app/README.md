# @jeevanand/browserbox-app

The BrowserBox app (agent, desktop and docs), served on localhost:

```sh
npx @jeevanand/browserbox-app            # opens http://127.0.0.1:4173/agent/
npx @jeevanand/browserbox-app --dir      # prints the path of the built site, to host it yourself
```

Options: `--port`, `--host`, `--no-open`, `--dir`. The server sends the cross-origin isolation headers, so real Node.js (WebContainers) works.

To use BrowserBox from your own code, install the SDK instead: [`@jeevanand/browserbox`](https://www.npmjs.com/package/@jeevanand/browserbox).
