// Web Worker entry: runs the analysis jobs off the main thread. See createRunner() in analyse.mjs.
//   { id, type: 'tree' | 'plan' | 'analyse', payload }  ->  { id, ok: true, result } | { id, ok: false, error }
// A message without a type is the original single-job form (the whole input of an analysis).
import { TASKS } from './analyse.mjs';

self.onmessage = (e) => {
  const m = e.data || {};
  const id = m.id;
  const type = m.type || 'analyse';
  const payload = m.type ? m.payload : m;
  try {
    if (!TASKS[type]) throw new Error(`Unknown job "${type}"`);
    self.postMessage({ id, ok: true, result: TASKS[type](payload) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
