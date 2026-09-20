// Web Worker entry: runs the analysis off the main thread. See runAnalysis() in analyse.mjs.
import { analyseSources } from './analyse.mjs';

self.onmessage = (e) => {
  try {
    self.postMessage({ ok: true, result: analyseSources(e.data) });
  } catch (err) {
    self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
