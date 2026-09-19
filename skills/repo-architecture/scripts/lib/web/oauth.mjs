// Browser side of "Sign in with GitHub". Pure functions, so the flow can be tested without a page.
//
//   1. startSignIn()      -> a GitHub authorize URL carrying a random `state` (remembered by the caller)
//   2. GitHub redirects back to the site with ?code=...&state=...
//   3. readCallback()     -> checks `state` matches what we sent, returns the code (or why it failed)
//   4. exchangeCode()     -> POSTs the code to the tiny exchange function (server/github-oauth) and gets a token
//
// The token then behaves exactly like a pasted personal access token: it lives in memory, is only sent to
// api.github.com, and is stored only if the user ticks "remember".

const AUTHORIZE = 'https://github.com/login/oauth/authorize';

/** A random, URL-safe state value. `crypto` is injectable for tests. */
export function newState(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param cfg   { clientId, scope? }  scope is only used by classic OAuth apps; GitHub Apps ignore it
 * @returns the URL to send the browser to
 */
export function authorizeUrl({ clientId, redirectUri, state, scope }) {
  const u = new URL(AUTHORIZE);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  if (scope) u.searchParams.set('scope', scope);
  return u.toString();
}

/**
 * Interprets the query string GitHub redirected back with.
 * @returns null when this is not an OAuth callback, else { code } or { error }
 */
export function readCallback(search, expectedState) {
  const q = new URLSearchParams(search || '');
  if (!q.has('code') && !q.has('error')) return null;
  if (!expectedState || q.get('state') !== expectedState) return { error: 'The sign-in response did not match this browser session, so it was ignored. Please try again.' };
  if (q.has('error')) return { error: q.get('error_description') || 'GitHub sign-in was cancelled.' };
  return { code: q.get('code') };
}

/** The current URL without OAuth parameters, so a reload does not replay a used code. */
export function cleanUrl(href) {
  const u = new URL(href);
  for (const k of ['code', 'state', 'error', 'error_description', 'error_uri']) u.searchParams.delete(k);
  return u.pathname + (u.search || '');
}

/** Trades the code for a token through the exchange function. Throws an Error with a user-facing message. */
export async function exchangeCode({ exchangeUrl, code, redirectUri, fetchImpl = globalThis.fetch }) {
  let res;
  try {
    res = await fetchImpl(exchangeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, redirect_uri: redirectUri }) });
  } catch {
    throw new Error('Could not reach the sign-in service. Try again, or paste a token instead.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* handled below */ }
  if (!res.ok || !data || !data.access_token) throw new Error(`GitHub sign-in failed${data && data.error ? ` (${data.error})` : ''}. Try again, or paste a token instead.`);
  return data.access_token;
}
