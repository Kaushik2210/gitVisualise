// The one thing a static site cannot do: trade a GitHub OAuth `code` for an access token, because that call
// needs the app's client secret. This module is that call and nothing else.
//
//   - stateless: no storage, no sessions, nothing is kept between requests
//   - never logs: there is no console call in this file, and the token only travels in the response body
//   - narrow: POST { code, redirect_uri } from an allowed origin; every other request is refused
//
// It uses only web-standard APIs (Request / Response / fetch), so the same function runs in a Cloudflare Worker,
// a Vercel or Netlify edge function, Deno or Node 18+. `worker.mjs` is the Cloudflare adapter.

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const CODE_RE = /^[A-Za-z0-9_-]{8,128}$/;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

/** Parses ALLOWED_ORIGINS ("https://a.github.io, http://localhost:4173") into a Set of origins. */
export function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean));
}

/**
 * @param request  a Request
 * @param env      { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ALLOWED_ORIGINS }
 * @param fetchImpl  injectable for tests
 */
export async function handle(request, env, fetchImpl = globalThis.fetch) {
  const origins = allowedOrigins(env);
  const origin = request.headers.get('origin') || '';
  const ok = origins.has(origin);
  // CORS headers are only ever sent to an allowed origin, so other sites cannot read a response.
  const cors = ok ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };

  if (request.method === 'OPTIONS') {
    return ok ? new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } }) : json(403, { error: 'origin_not_allowed' }, cors);
  }
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { ...cors, allow: 'POST, OPTIONS' });
  if (!ok) return json(403, { error: 'origin_not_allowed' }, cors);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json(500, { error: 'not_configured' }, cors);

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'invalid_json' }, cors); }
  const code = body && body.code;
  const redirectUri = body && body.redirect_uri;
  if (typeof code !== 'string' || !CODE_RE.test(code)) return json(400, { error: 'invalid_code' }, cors);
  // The redirect URI must live on an allowed origin, or an attacker could bind a stolen code to their own page.
  let redirectOrigin = null;
  try { redirectOrigin = new URL(redirectUri).origin; } catch { /* handled below */ }
  if (!redirectOrigin || !origins.has(redirectOrigin)) return json(400, { error: 'invalid_redirect_uri' }, cors);

  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
    });
  } catch {
    return json(502, { error: 'github_unreachable' }, cors);
  }
  let data = null;
  try { data = await res.json(); } catch { /* fall through */ }
  if (!data || data.error || !data.access_token) return json(400, { error: (data && data.error) || 'exchange_failed' }, cors);
  // Only what the browser needs. The client secret never appears in a response.
  return json(200, { access_token: data.access_token, token_type: data.token_type || 'bearer', scope: data.scope || '' }, cors);
}
