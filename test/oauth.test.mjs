// Sign in with GitHub: the stateless exchange function and the browser-side helpers.
import test from 'node:test';
import { webcrypto } from 'node:crypto'; // Node 18 has no global crypto
import assert from 'node:assert/strict';
import { handle } from '../server/github-oauth/exchange.mjs';
import { newState, authorizeUrl, readCallback, cleanUrl, exchangeCode } from '../skills/repo-architecture/scripts/lib/web/oauth.mjs';

const ENV = { GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'super-secret-value', ALLOWED_ORIGINS: 'https://me.github.io, http://localhost:4173/' };
const SITE = 'https://me.github.io';
const post = (body, origin = SITE) => new Request('https://exchange.test/', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const githubOk = () => { const calls = []; const impl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ access_token: 'gho_abc', token_type: 'bearer', scope: 'repo' }), { status: 200 }); }; return { impl, calls }; };

test('exchange: trades a code for a token, sending the secret only to GitHub', async () => {
  const gh = githubOk();
  const res = await handle(post({ code: 'abcdef123456', redirect_uri: SITE + '/gitVisualise/' }), ENV, gh.impl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  assert.deepEqual(await res.json(), { access_token: 'gho_abc', token_type: 'bearer', scope: 'repo' });
  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0].url, 'https://github.com/login/oauth/access_token');
  const sent = JSON.parse(gh.calls[0].init.body);
  assert.equal(sent.client_secret, 'super-secret-value');
  assert.equal(sent.code, 'abcdef123456');
});

test('exchange: never returns the client secret, even when GitHub errors', async () => {
  const impl = async () => new Response(JSON.stringify({ error: 'bad_verification_code', echo: 'super-secret-value' }), { status: 200 });
  const res = await handle(post({ code: 'abcdef123456', redirect_uri: SITE + '/' }), ENV, impl);
  const text = await res.text();
  assert.equal(res.status, 400);
  assert.ok(!text.includes('super-secret-value'));
  assert.deepEqual(JSON.parse(text), { error: 'bad_verification_code' });
});

test('exchange: refuses other origins, other methods, bad codes and foreign redirect URIs without calling GitHub', async () => {
  const gh = githubOk();
  const refused = async (req) => { const r = await handle(req, ENV, gh.impl); return [r.status, r.headers.get('access-control-allow-origin')]; };
  assert.deepEqual(await refused(post({ code: 'abcdef123456', redirect_uri: SITE + '/' }, 'https://evil.example')), [403, null]);
  assert.deepEqual(await refused(post({ code: 'abcdef123456', redirect_uri: SITE + '/' }, null)), [403, null]);
  assert.deepEqual(await refused(new Request('https://exchange.test/', { method: 'GET', headers: { origin: SITE } })), [405, SITE]);
  assert.deepEqual(await refused(post({ code: 'x', redirect_uri: SITE + '/' })), [400, SITE]);
  assert.deepEqual(await refused(post({ code: 'abcdef123456', redirect_uri: 'https://evil.example/' })), [400, SITE]);
  assert.deepEqual(await refused(post({ code: 'abcdef123456' })), [400, SITE]);
  assert.deepEqual(await refused(post('not json')), [400, SITE]);
  assert.equal(gh.calls.length, 0, 'GitHub is never contacted for a refused request');
});

test('exchange: answers the CORS preflight only for an allowed origin, and reports a missing secret', async () => {
  const pre = (origin) => new Request('https://exchange.test/', { method: 'OPTIONS', headers: { origin } });
  const ok = await handle(pre('http://localhost:4173'), ENV);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:4173');
  assert.equal((await handle(pre('https://evil.example'), ENV)).status, 403);
  const res = await handle(post({ code: 'abcdef123456', redirect_uri: SITE + '/' }), { ALLOWED_ORIGINS: SITE });
  assert.equal(res.status, 500);
});

test('exchange: contains no logging calls', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/github-oauth/exchange.mjs', import.meta.url), 'utf8');
  assert.ok(!/console\./.test(src), 'a token exchange function must never log');
});

test('client: authorize URL, state and callback handling', () => {
  const state = newState(webcrypto);
  assert.match(state, /^[0-9a-f]{32}$/);
  assert.notEqual(state, newState(webcrypto));
  const u = new URL(authorizeUrl({ clientId: 'Iv1.test', redirectUri: SITE + '/x/', state, scope: 'repo' }));
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('state'), state);
  assert.equal(u.searchParams.get('redirect_uri'), SITE + '/x/');
  assert.ok(!new URL(authorizeUrl({ clientId: 'a', redirectUri: SITE, state })).searchParams.has('scope'));

  assert.equal(readCallback('?foo=1', state), null);                                   // not a callback
  assert.deepEqual(readCallback(`?code=abc123&state=${state}`, state), { code: 'abc123' });
  assert.match(readCallback('?code=abc123&state=forged', state).error, /did not match/);   // CSRF: wrong state
  assert.match(readCallback('?code=abc123', null).error, /did not match/);                 // nothing was started here
  assert.match(readCallback(`?error=access_denied&error_description=Nope&state=${state}`, state).error, /Nope/);
  assert.equal(cleanUrl('https://me.github.io/gitVisualise/?code=a&state=b&keep=1'), '/gitVisualise/?keep=1');
});

test('client: exchangeCode returns the token or a readable error', async () => {
  const ok = async (url, init) => { assert.equal(JSON.parse(init.body).redirect_uri, SITE + '/'); return new Response(JSON.stringify({ access_token: 'gho_x' }), { status: 200 }); };
  assert.equal(await exchangeCode({ exchangeUrl: 'https://x/', code: 'c', redirectUri: SITE + '/', fetchImpl: ok }), 'gho_x');
  const bad = async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 400 });
  await assert.rejects(() => exchangeCode({ exchangeUrl: 'https://x/', code: 'c', redirectUri: SITE, fetchImpl: bad }), /bad_verification_code/);
  const down = async () => { throw new TypeError('offline'); };
  await assert.rejects(() => exchangeCode({ exchangeUrl: 'https://x/', code: 'c', redirectUri: SITE, fetchImpl: down }), /Could not reach/);
});
