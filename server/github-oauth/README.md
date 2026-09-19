# Sign in with GitHub (optional)

gitvisualise is a static site: it has no backend, and that stays true for everyone who does not sign in.
Signing in exists for one reason, reading **private repositories** without pasting a personal access token.

GitHub's OAuth web flow ends with a request that needs the app's **client secret**, which can never live in a
static page. This folder holds the smallest possible thing that can do that one request:

| File | What it is |
|---|---|
| [`exchange.mjs`](exchange.mjs) | `handle(request, env)`: trades an OAuth `code` for a token. Web-standard APIs only (Request, Response, fetch) |
| [`worker.mjs`](worker.mjs) | Cloudflare Worker adapter (three lines) |
| [`wrangler.toml.example`](wrangler.toml.example) | Deploy config |

The browser half is [`oauth.mjs`](../../skills/repo-architecture/scripts/lib/web/oauth.mjs), wired into the site behind a flag in
[`site/config.js`](../../site/config.js). While `OAUTH` is `null` (the default) the button does not exist and nothing here runs.

## How it works

```
browser                          exchange function                     github.com
  |  1. redirect to /login/oauth/authorize?client_id&state  ---------------->|
  |<-- 2. redirect back to the site with ?code&state  -----------------------|
  |  3. POST { code, redirect_uri }  -->|                                     |
  |                                     |  4. POST access_token (+ secret) -->|
  |                                     |<-- 5. { access_token } -------------|
  |<-- 6. { access_token } -------------|
  |  7. token kept in memory; sent only to api.github.com
```

The site checks the `state` value it generated (kept in `sessionStorage`) before it accepts a callback, so a forged
redirect is ignored. After sign-in the token behaves exactly like a pasted one: in memory, only sent to
`api.github.com`, stored only if "Remember on this device" is ticked.

## Guarantees of the exchange function

- **Stateless.** No database, no KV, no sessions. Nothing survives a request.
- **Never logs.** There is no `console` call in `exchange.mjs`; a test fails if one is added.
- **Narrow.** Only `POST { code, redirect_uri }` from an origin in `ALLOWED_ORIGINS`; anything else is refused before GitHub is contacted.
  `redirect_uri` must also be on an allowed origin, so a stolen code cannot be bound to someone else's page.
- **Secret stays put.** The client secret is only ever sent to `github.com`; responses contain just `access_token`, `token_type` and `scope`.
- **CORS only for allowed origins**, so other sites cannot read a response.

## Decisions to make (why this is behind a flag)

These are the maintainer's calls, and the code does not force any of them:

1. **GitHub App, not an OAuth app.** A classic OAuth app cannot ask for read-only access to private repos: its smallest scope, `repo`,
   also grants write. A **GitHub App** with only *Contents: read* and *Metadata: read* (user-to-server tokens) is the least-privilege option,
   and the exchange endpoint is the same one. Recommended. For a GitHub App leave `scope` empty.
2. **Where to host the official instance.** Cloudflare Workers has a free tier and needs no server; Vercel/Netlify functions work with the same
   `handle()`. Self-hosters deploy their own copy and point `site/config.js` at it, so no one has to trust a shared instance.
3. **Token lifetime.** User-to-server tokens from a GitHub App can expire (8 hours) and come with a refresh token. This first version does not
   refresh: when the token expires the user signs in again. Refresh can be added to `exchange.mjs` later without changing the client contract.

## Turning it on

You need a GitHub account that can register an app, and somewhere to deploy the function. Nothing below can be done from the repository alone.

1. **Register the app** (Settings → Developer settings). Homepage URL: your site. Callback URL: exactly your site's URL, e.g.
   `https://kaushik2210.github.io/gitVisualise/`. For a GitHub App, grant the permissions *Contents: read* and *Metadata: read* only.
   Generate a client secret.
2. **Deploy the function** (Cloudflare shown):

   ```bash
   cd server/github-oauth
   cp wrangler.toml.example wrangler.toml
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler deploy
   ```

   Set `GITHUB_CLIENT_ID` and `ALLOWED_ORIGINS` (comma-separated site origins, e.g. `https://kaushik2210.github.io,http://localhost:4173`) as variables.
3. **Enable it** in [`site/config.js`](../../site/config.js):

   ```js
   export const OAUTH = { clientId: 'Iv1.xxxxxxxx', exchangeUrl: 'https://gv-oauth.<you>.workers.dev/', scope: '' };
   ```

   then `npm run site` and commit `docs/`.
4. Try it locally first with `ALLOWED_ORIGINS` including `http://localhost:4173` and a second app whose callback is that URL.

## Testing

```bash
node --test test/oauth.test.mjs
```

The tests run the handler with an injected `fetch`, so no network or credentials are involved.
