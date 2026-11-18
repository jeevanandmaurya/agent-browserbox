# Shipping: GitHub and deploys

BrowserBox can push code to GitHub and publish sites to Netlify, Vercel or GitHub Pages. It uses each service's web API, which works from a browser.

## Accounts

Add tokens in **Settings → Accounts**. They are stored encrypted, and only BrowserBox's kernel reads them.

- **GitHub**: a fine-grained token from github.com/settings/personal-access-tokens, with Contents, Pull requests, Pages and Administration (read and write) for your repositories. Or run `gh auth login` in the Terminal.
- **Netlify**: a personal access token from app.netlify.com/user/applications.
- **Vercel**: a token from vercel.com/account/tokens.

## GitHub

- `gh push [folder] [--repo owner/name] [--branch main] [-m "message"]` commits the folder's current files to the branch, as **one commit**. Only changed files are uploaded, `.gitignore` is respected, and the repository is created (private) if it does not exist. The folder remembers where it was pushed.
- `gh repo clone owner/name [folder]`, `gh repo create name [--public]`
- `gh pr create --head branch --title "…" [--body "…"] [--base main]`

A push does not carry your local git history; GitHub's API takes the files, not git's own protocol, which browsers cannot use.

## Deploying

- `build [folder]`: a production build into `dist/` (bundled, minified, npm packages included).
- `deploy [folder] --to netlify | vercel | github-pages`: builds, uploads, waits until the site is live and prints its address. Later deploys of the folder update the same site.

These are static hosts: a `server.ts` backend is not deployed.

The agent can do all of this with its `github` and `deploy` tools; just ask, for example "push this to a new repo and deploy it to Netlify".
