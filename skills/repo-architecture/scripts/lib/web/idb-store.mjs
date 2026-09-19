// IndexedDB-backed key/value store for cache.mjs. Returns null when IndexedDB is unavailable (some private windows,
// blocked storage, old browsers) so callers can fall back to "no cache" without special cases.

export function idbStore(dbName = 'gitvisualise', storeName = 'tours') {
  let idb;
  try { idb = globalThis.indexedDB; } catch { return null; }
  if (!idb) return null;

  let dbPromise = null;
  const open = () => (dbPromise ||= new Promise((resolve, reject) => {
    let req;
    try { req = idb.open(dbName, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(storeName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)),
    delete: (k) => run('readwrite', (s) => s.delete(k)),
    keys: () => run('readonly', (s) => s.getAllKeys()),
  };
}
