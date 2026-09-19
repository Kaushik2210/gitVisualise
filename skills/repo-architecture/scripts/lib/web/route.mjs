// Pure URL-state helpers for the website, kept out of app.js so they can be unit tested without a DOM.
//
//   #/owner/repo[@ref]                                  open a repository
//   #/owner/repo@base...head                            compare two revisions
//   #/owner/repo[@ref]/flow/<flow-id>/step/<n>          open a tour at a step (n is 1-based)
import { parseRepoInput } from './github-loader.mjs';

// A comparison is written owner/repo@base...head (head may be empty for the default branch).
export const keyOf = (t) => `${t.owner}/${t.repo}${t.base ? '@' + t.base + '...' + (t.ref || '') : t.ref ? '@' + t.ref : ''}${t.path ? ':' + t.path : ''}`;
export const hashOf = (t) => '#/' + keyOf(t);

/** Returns { target, goto } or null. `goto` is { flow, step } or null. */
export function parseHash(hash) {
  const m = /^#\/(.+?)(?:\/flow\/([^/]+)\/step\/(\d+))?$/.exec(hash || '');
  const target = m && parseRepoInput(m[1]);
  if (!target) return null;
  let flow = null;
  if (m[2]) {
    try { flow = decodeURIComponent(m[2]); } catch { return { target, goto: null }; }
  }
  return { target, goto: flow ? { flow, step: Number(m[3]) } : null };
}

/** The "/flow/x/step/n" suffix for a reported position, or "" for the overview. */
export const stateSuffix = (st) => (st && st.step > 0 && st.flow ? '/flow/' + encodeURIComponent(st.flow) + '/step/' + st.step : '');
