// The CPU-heavy half of analysing a repository: scan the downloaded files, generate the architecture and validate it.
// It is a pure function of its input, so it runs unchanged on the main thread (tests, Node) or in a Web Worker (the website,
// where scanning hundreds of files would otherwise freeze the page and stall the progress bar).
import { scanCore } from '../core/scan-core.mjs';
import { validateCore } from '../core/validate-core.mjs';
import { generate } from '../generate.mjs';

/** A read-only view of the repo (the same shape the CLI validator uses), backed by the tree + downloaded files. */
export function makeView(paths, contents) {
  const files = new Set(paths);
  const dirs = new Set();
  for (const p of paths) {
    const s = p.split('/');
    for (let i = 1; i < s.length; i++) dirs.add(s.slice(0, i).join('/'));
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

/**
 * Runs analyseSources in a module Worker when asked and available, and on this thread otherwise (no Worker in Node, a browser
 * that cannot start module workers, a CSP that forbids them). Aborting terminates the worker.
 */
export function runAnalysis(input, { worker = false, signal } = {}) {
  const here = () => Promise.resolve().then(() => analyseSources(input));
  if (!worker || typeof Worker !== 'function') return here();
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./analysis-worker.mjs', import.meta.url), { type: 'module' }); } catch { return here().then(resolve, reject); }
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; if (signal) signal.removeEventListener('abort', onAbort); w.terminate(); fn(v); };
    const onAbort = () => finish(reject, new DOMException('Aborted', 'AbortError'));
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
    w.onmessage = (e) => (e.data && e.data.ok ? finish(resolve, e.data.result) : finish(reject, new Error((e.data && e.data.error) || 'The analysis worker failed')));
    // the worker file could not load or crashed: do the work here instead of failing the analysis
    w.onerror = (e) => { if (done) return; e.preventDefault && e.preventDefault(); done = true; if (signal) signal.removeEventListener('abort', onAbort); w.terminate(); here().then(resolve, reject); };
    w.postMessage(input);
  });
}
