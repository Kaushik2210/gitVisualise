// The CPU-heavy half of analysing a repository: scan the downloaded files, generate the architecture and validate it.
// It is a pure function of its input, so it runs unchanged on the main thread (tests, Node) or in a Web Worker (the website,
// where scanning hundreds of files would otherwise freeze the page and stall the progress bar).
import { scanCore } from '../core/scan-core.mjs';
import { validateCore } from '../core/validate-core.mjs';
import { generate } from '../generate.mjs';
import { readTree, planSources } from './tree-plan.mjs';

/** A read-only view of the repo (the same shape the CLI validator uses), backed by the tree + downloaded files. */
export function makeView(paths, contents) {
  const files = new Set(paths);
  const dirs = new Set();
  for (const p of paths) {
    // Every ancestor directory. A directory is only ever added together with all of its ancestors, so the walk up can stop at the
    // first one already known: this is about one lookup per file instead of one string per path segment (7,000 files in a big repo).
    for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
      const d = p.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
    }
  }
  let names = null;
  return {
    exists: (rel) => (files.has(rel) ? 'file' : dirs.has(rel) ? 'dir' : null),
    read: (rel) => (contents.has(rel) ? contents.get(rel) : null),
    list: (rel) => {
      const prefix = rel ? rel.replace(/\/$/, '') + '/' : '';
      const out = new Set();
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length).split('/');
        out.add(rest.length > 1 ? rest[0] + '/' : rest[0]);
      }
      return [...out].sort();
    },
    hasBasename: (name) => {
      if (!names) names = new Set(paths.map((p) => p.slice(p.lastIndexOf('/') + 1)));
      return names.has(name);
    },
  };
}

/**
 * @param input { paths, allPaths, contents: Map<path, text>, repo: { name, url, branch, commit }, sub, alreadySkipped, notes, layout }
 * @returns { arch, validation, workspaces, depth }
 */
export function analyseSources({ paths, allPaths, contents, repo, sub = '', alreadySkipped, notes = [], layout }) {
  const read = (p) => (contents.has(p) ? contents.get(p) : null);
  const scan = scanCore({ paths, read, repo, root: '', subPath: sub });
  const lay = layout ? { ...layout } : {};
  const arch = generate(scan, { alreadySkipped, extraNotes: notes, noIncludeHint: true, layout: lay });
  arch.project.repoUrl = repo.url;
  arch.project.generatedBy = 'heuristic';
  const validation = validateCore(arch, makeView(allPaths, contents));
  return { arch, validation, workspaces: scan.workspaces, depth: lay.depth };
}

/** Every job the analysis worker can run. Each is a pure function of its (cloneable) input. */
export const TASKS = { analyse: analyseSources, tree: readTree, plan: planSources };

/**
 * Runs jobs in one module Worker when asked and available, and on this thread otherwise (no Worker in Node, a browser that
 * cannot start module workers, a CSP that forbids them). If the worker cannot load or crashes, the jobs it was holding run here
 * instead of failing the analysis. Aborting terminates the worker and rejects what is pending with an AbortError.
 *   const r = createRunner({ worker: true, signal }); const tree = await r.run('tree', text); ...; r.close();
 */
export function createRunner({ worker = false, signal } = {}) {
  const local = (type, payload) => Promise.resolve().then(() => TASKS[type](payload));
  if (!worker || typeof Worker !== 'function') return { run: (type, payload) => (signal && signal.aborted ? Promise.reject(new DOMException('Aborted', 'AbortError')) : local(type, payload)), close() {} };
  let w = null, dead = false, closed = false, next = 1;
  const pending = new Map();
  const abortError = () => new DOMException('Aborted', 'AbortError');
  const close = () => { closed = true; if (signal) signal.removeEventListener('abort', onAbort); if (w) { w.terminate(); w = null; } };
  const onAbort = () => { const jobs = [...pending.values()]; pending.clear(); close(); jobs.forEach((j) => j.reject(abortError())); };
  const giveUp = () => { // the worker is unusable: finish what it was holding on this thread, and use this thread from now on
    dead = true;
    if (w) { w.terminate(); w = null; }
    const jobs = [...pending.values()];
    pending.clear();
    jobs.forEach((j) => local(j.type, j.payload).then(j.resolve, j.reject));
  };
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    w = new Worker(new URL('./analysis-worker.mjs', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const d = e.data || {};
      const job = pending.get(d.id);
      if (!job) return;
      pending.delete(d.id);
      if (d.ok) job.resolve(d.result); else job.reject(new Error(d.error || 'The analysis worker failed'));
    };
    w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); if (!closed) giveUp(); };
  } catch { dead = true; w = null; }
  return {
    run(type, payload) {
      if (signal && signal.aborted) return Promise.reject(abortError());
      if (dead || closed || !w) return local(type, payload);
      return new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { type, payload, resolve, reject });
        try { w.postMessage({ id, type, payload }); } catch { pending.delete(id); local(type, payload).then(resolve, reject); }
      });
    },
    close,
  };
}

/** One analysis job in a worker (or here); kept for callers that only need that. */
export function runAnalysis(input, { worker = false, signal } = {}) {
  const runner = createRunner({ worker, signal });
  return runner.run('analyse', input).finally(() => runner.close());
}
