// A small, bounded, failure-tolerant cache for analysed tours. Storage is injected, so the logic is unit tested in
// Node with an in-memory store and runs in browsers on top of IndexedDB (see idb-store.mjs).
//
//  - keyed by owner/repo@commit, so an entry is valid forever for that commit
//  - least-recently-used eviction once `max` entries are stored
//  - every storage error is swallowed: a broken or unavailable store simply behaves like an empty cache
//  - a version prefix lets a new release ignore entries written by an older data format

export const cacheKey = (owner, repo, sha, extra = '') => `${owner}/${repo}@${sha}${extra}`.toLowerCase();

/** In-memory store with the same async interface as the IndexedDB one (used by tests and as a fallback). */
export function memoryStore() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { m.delete(k); },
    async keys() { return [...m.keys()]; },
  };
}

const NOOP = { enabled: false, async get() { return null; }, async set() {}, async clear() {}, async count() { return 0; } };

// Cached tours are generator output: bump this whenever the scanner or generator changes what it produces,
// so tours written by an older release are ignored instead of shown stale.
export const DATA_VERSION = 'v3';

/**
 * @param store  { get, set, delete, keys } (all async) or null/undefined to disable caching
 * @param opts    { max: entries to keep, maxBytes: skip values larger than this, version: data format tag }
 */
export function createCache(store, { max = 30, maxBytes = 6 * 1024 * 1024, version = DATA_VERSION } = {}) {
  if (!store) return NOOP;
  const INDEX = `${version}:__index__`;
  const k = (key) => `${version}:${key}`;
  const readIndex = async () => {
    try { return (await store.get(INDEX)) || {}; } catch { return {}; }
  };
  const writeIndex = async (idx) => {
    try { await store.set(INDEX, idx); } catch { /* ignore */ }
  };
  return {
    enabled: true,
    async get(key) {
      try {
        const v = await store.get(k(key));
        if (v === undefined || v === null) return null;
        const idx = await readIndex();
        if (idx[key]) { idx[key].t = Date.now(); await writeIndex(idx); } // mark as recently used
        return v;
      } catch { return null; }
    },
    async set(key, value) {
      try {
        if (JSON.stringify(value).length > maxBytes) return; // too large to be worth keeping
        await store.set(k(key), value);
        const idx = await readIndex();
        idx[key] = { t: Date.now() };
        const keys = Object.keys(idx).sort((a, b) => idx[b].t - idx[a].t);
        for (const old of keys.slice(max)) { // evict least recently used
          delete idx[old];
          try { await store.delete(k(old)); } catch { /* ignore */ }
        }
        await writeIndex(idx);
      } catch { /* a failing store must never break the app */ }
    },
    async clear() {
      try {
        const idx = await readIndex();
        for (const key of Object.keys(idx)) { try { await store.delete(k(key)); } catch { /* ignore */ } }
        await store.delete(INDEX);
      } catch { /* ignore */ }
    },
    async count() { return Object.keys(await readIndex()).length; },
  };
}
