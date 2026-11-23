# @jeevanand/agent-browserbox-runtime

The runtime that [`@jeevanand/agent-browserbox-sdk`](../sdk) drives: BrowserBox's
kernel, filesystem, shell and sandboxes, as static files. Install it when you
want to serve the runtime yourself instead of using the hosted one.

```sh
npx @jeevanand/agent-browserbox-runtime          # serves it at http://127.0.0.1:4180/
npx @jeevanand/agent-browserbox-runtime --dir    # prints the folder, to copy into your site
```

```ts
BrowserBox.boot({ runtimeUrl: 'http://127.0.0.1:4180/' });
```

From Node, `import { runtimeDir } from '@jeevanand/agent-browserbox-runtime'`
gives the same folder, e.g. to copy it into your build output.

Serve it from **a different origin from your app** where you can: the box is
isolated by the origin boundary. Any static host works; no special headers are
required. Pages that use cross-origin isolation themselves should also send
`Cross-Origin-Resource-Policy: cross-origin` and
`Cross-Origin-Embedder-Policy: credentialless` for the runtime (the bundled
server does).

Origins that may use the runtime default to any: browsers partition each
embedding site's storage, so sites never see each other's boxes. To restrict
it, build from source with `VITE_EMBED_ORIGINS=https://a.example,https://b.example`.

Use the same version as the SDK.

## The kernel client (`/client`)

Most code should use the SDK. Apps that drive the kernel directly (windows,
desktops, the BrowserBox app itself) can use the runtime's client over the
SDK's kernel channel:

```ts
import { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import { RemoteKernel } from '@jeevanand/agent-browserbox-runtime/client';

const box = await BrowserBox.boot();
const kernel = new RemoteKernel(box.kernelPort());
await kernel.fs.writeFile('/home/user/hi.txt', 'hello');
```

`/client` also exports the kernel's types (`Kernel`, `FsApi`, `Proc`, …) and
small helpers (paths, file types, ANSI). It contains no kernel code.

## License

MIT
