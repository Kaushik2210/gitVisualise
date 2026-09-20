// The analysis step that the website runs in a Web Worker: same result on either thread, and a safe fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseSources, runAnalysis, makeView } from '../skills/repo-architecture/scripts/lib/web/analyse.mjs';
import { analyzeRepo, makeView as reExported } from '../skills/repo-architecture/scripts/lib/web/github-loader.mjs';

const files = {
  'package.json': '{"name":"w","main":"a.js"}',
  'a.js': "import { b } from './b.js';\nexport const a = b;\n",
  'b.js': "import { c } from './c.js';\nexport const b = c;\n",
  'c.js': 'export const c = 1;\n',
};
const input = () => ({
  paths: Object.keys(files), allPaths: Object.keys(files), contents: new Map(Object.entries(files)),
  repo: { name: 'w', url: 'https://github.com/o/w', branch: null, commit: 'a'.repeat(40) }, sub: '', alreadySkipped: { tests: 0, examples: 0, tooling: 0 }, notes: [],
});

test('analyse: produces a validated architecture and the node granularity it used', () => {
  const r = analyseSources(input());
  assert.deepEqual(r.validation.errors, []);
  assert.equal(r.arch.project.repoUrl, 'https://github.com/o/w');
  assert.equal(r.arch.project.generatedBy, 'heuristic');
  assert.ok(r.arch.nodes.length >= 3 && r.arch.edges.length >= 2);
  assert.equal(typeof r.depth, 'number');
  assert.ok(Array.isArray(r.workspaces));
  assert.equal(reExported, makeView, 'the loader still exports makeView');
  assert.equal(makeView(['a/b.js'], new Map()).exists('a'), 'dir');
});

test('analyse: a layout depth passed in is used, so two revisions share node ids', () => {
  const nested = {
    'package.json': '{"name":"w","main":"src/app/main.js"}',
    'src/app/main.js': "import { u } from '../lib/util.js';\nimport { d } from '../data/store.js';\nconsole.log(u, d);\n",
    'src/lib/util.js': 'export const u = 1;\n',
    'src/lib/more.js': 'export const m = 1;\n',
    'src/data/store.js': 'export const d = 1;\n',
  };
  const inp = { ...input(), paths: Object.keys(nested), allPaths: Object.keys(nested), contents: new Map(Object.entries(nested)) };
  const perFile = analyseSources({ ...inp, layout: { depth: 0 } });
  const grouped = analyseSources({ ...inp, layout: { depth: 1 } });
  assert.equal(perFile.depth, 0);
  assert.equal(grouped.depth, 1);
  assert.ok(grouped.arch.nodes.length < perFile.arch.nodes.length, 'depth 1 groups files into directories');
  assert.notDeepEqual(perFile.arch.nodes.map((n) => n.id), grouped.arch.nodes.map((n) => n.id));
});

test('runAnalysis: without a Worker (Node, or a browser that cannot start one) it runs here and returns the same result', async () => {
  assert.equal(typeof globalThis.Worker, 'undefined');
  const direct = analyseSources(input());
  const viaRun = await runAnalysis(input(), { worker: true });
  assert.deepEqual(viaRun.arch.nodes.map((n) => n.id), direct.arch.nodes.map((n) => n.id));
  const off = await runAnalysis(input(), { worker: false });
  assert.deepEqual(off.arch.edges.map((e) => e.id), direct.arch.edges.map((e) => e.id));
});

/** A stand-in Worker so the worker path can be exercised in Node. */
function withFakeWorker(behaviour, fn) {
  const made = [];
  globalThis.Worker = class {
    constructor(url, opts) { made.push({ url: String(url), opts, terminated: false }); this.rec = made[made.length - 1]; setTimeout(() => behaviour(this), 5); }
    postMessage(data) { this.rec.received = data; }
    terminate() { this.rec.terminated = true; }
  };
  return fn(made).finally(() => { delete globalThis.Worker; });
}

test('runAnalysis: uses the worker when there is one, and terminates it afterwards', async () => {
  const fake = { ok: true, result: { arch: { nodes: [], edges: [] }, validation: { errors: [], warnings: [] }, workspaces: [], depth: 7 } };
  await withFakeWorker((w) => w.onmessage({ data: fake }), async (made) => {
    const r = await runAnalysis(input(), { worker: true });
    assert.equal(r.depth, 7, 'the worker\'s answer is used');
    assert.match(made[0].url, /analysis-worker\.mjs$/);
    assert.equal(made[0].opts.type, 'module');
    assert.ok(made[0].received.contents instanceof Map, 'the downloaded files are handed over');
    assert.equal(made[0].terminated, true);
  });
});

test('runAnalysis: a worker that fails to load falls back to the main thread instead of failing the analysis', async () => {
  await withFakeWorker((w) => w.onerror({ preventDefault() {} }), async (made) => {
    const r = await runAnalysis(input(), { worker: true });
    assert.deepEqual(r.validation.errors, []);
    assert.ok(r.arch.nodes.length >= 3, 'the real analysis ran here');
    assert.equal(made[0].terminated, true);
  });
  // an error the worker reports about the analysis itself is an error, not a reason to silently redo it
  await withFakeWorker((w) => w.onmessage({ data: { ok: false, error: 'boom' } }), async () => {
    await assert.rejects(() => runAnalysis(input(), { worker: true }), /boom/);
  });
});

test('runAnalysis: aborting stops the worker and rejects with AbortError', async () => {
  const ctl = new AbortController();
  await withFakeWorker(() => { /* never answers */ }, async (made) => {
    const p = runAnalysis(input(), { worker: true, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(() => p, (e) => e.name === 'AbortError');
    assert.equal(made[0].terminated, true);
  });
  const already = new AbortController(); already.abort();
  await withFakeWorker(() => {}, async () => {
    await assert.rejects(() => runAnalysis(input(), { worker: true, signal: already.signal }), (e) => e.name === 'AbortError');
  });
});

test('analyzeRepo: the worker option is optional, and a full analysis still works through the loader', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'api.github.com') {
      if (/\/commits\//.test(u.pathname)) return new Response('c'.repeat(40));
      return new Response(JSON.stringify({ truncated: false, tree: Object.keys(files).map((p) => ({ path: p, type: 'blob', size: files[p].length })) }));
    }
    const p = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
    return files[p] != null ? new Response(files[p]) : new Response('', { status: 404 });
  };
  for (const worker of [false, true]) {
    const r = await analyzeRepo({ owner: 'o', repo: 'w', ref: null }, { fetchImpl, worker });
    assert.deepEqual(r.validation.errors, []);
    assert.ok(r.arch.nodes.length >= 3);
    assert.equal(r.view.exists('a.js'), 'file');
  }
});
