// Helpers for `gitvisualise watch`: which changes matter, and a debouncer. Kept pure so they can be tested.
import { IGNORE_DIRS } from './core/scan-core.mjs';

/**
 * Classifies a changed path (relative to the repository root, any slash style).
 * @returns 'ignore' | 'source' | 'architecture'
 *   architecture = the hand-edited architecture.json, which only needs a rebuild, not a regenerate
 */
export function classifyChange(rel, { outRel = '', recentBuild = false } = {}) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!p) return 'ignore';
  const segs = p.split('/');
  if (segs.some((s) => IGNORE_DIRS.has(s) || s === '.git')) return 'ignore';
  if (/(^|\/)(\.DS_Store|Thumbs\.db)$|~$|\.(swp|swx|tmp)$|(^|\/)\.#/.test(p)) return 'ignore'; // editor noise
  const out = outRel.replace(/^\/|\/$/g, '');
  if (out && (p === out || p.startsWith(out + '/'))) {
    // Our own output is never a trigger, except a hand edit of architecture.json made after the last build finished.
    return !recentBuild && p === out + '/architecture.json' ? 'architecture' : 'ignore';
  }
  return 'source';
}

/** Calls `fn` once, `ms` after the last call. `flush()` runs it now; `cancel()` drops it. */
export function debounce(fn, ms) {
  let timer = null;
  const d = (...args) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(...args); }, ms); };
  d.cancel = () => { clearTimeout(timer); timer = null; };
  d.flush = (...args) => { d.cancel(); fn(...args); };
  return d;
}
