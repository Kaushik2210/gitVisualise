// Deployment settings for the website. Everything here is optional and off by default.
//
// OAUTH enables the "Sign in with GitHub" button (private repositories without pasting a token).
// It needs a GitHub OAuth app or GitHub App plus the tiny exchange function in server/github-oauth,
// which keeps the client secret out of the browser. See server/github-oauth/README.md.
//
//   export const OAUTH = { clientId: 'Iv1.abc123', exchangeUrl: 'https://gv-oauth.example.workers.dev/', scope: '' };
//
// Leave it null and the site stays fully static with no sign-in, exactly as before.
export const OAUTH = null;
