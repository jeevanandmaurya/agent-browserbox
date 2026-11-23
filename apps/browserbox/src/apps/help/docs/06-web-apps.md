# Building web apps

## The dev server

`serve [folder]` (or `npm run dev`, `npx vite`) serves a project at `http://localhost:3000/` and opens it in **Preview**. This address is virtual: it works inside BrowserBox, not in other tabs.

- Pages come from `index.html`, or one is generated for a project with only `src/main.tsx` (`.ts`, `.jsx`, `.js`).
- TypeScript, JSX, CSS, CSS modules, JSON and images are bundled automatically.
- `npm install react` records the package in `package.json`; packages load from esm.sh when the app is bundled and are cached for offline use. There is no `node_modules`.
- Saving a file reloads Preview.

## A backend

A `server.ts` (or `server.js`) answers the page's requests that are not files:

```ts
export default {
  async fetch(request: Request, env) {
    return Response.json({ hello: 'world' });
  },
};
```

It stays loaded between requests (so in-memory data works), `env.fs` reads and writes project files, and `.env` values are in `env`. It has no network unless started with `serve --net`.

## Checking your app

Preview's **console** shows the page's output, errors, failed requests and build errors. The agent reads the same with its `preview_logs` tool, so it can see when something it built is broken. The full-screen button shows the app on its own.

## Commands

`serve list`, `serve logs`, `serve stop`. For a production build, see [Shipping](shipping).
