// The analysis step that the website runs in a Web Worker: same result on either thread, and a safe fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseSources, runAnalysis, createRunner, makeView, TASKS } from '../skills/repo-architecture/scripts/lib/web/analyse.mjs';
import { readTree, planSources } from '../skills/repo-architecture/scripts/lib/web/tree-plan.mjs';
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
function withFakeWorker(behaviour, fn, onPost) {
  const made = [];
  globalThis.Worker = class {
    constructor(url, opts) { made.push({ url: String(url), opts, terminated: false }); this.rec = made[made.length - 1]; setTimeout(() => behaviour(this), 5); }
    postMessage(data) { this.rec.received = data; if (onPost) onPost(this, data); }
    terminate() { this.rec.terminated = true; }
  };
  return fn(made).finally(() => { delete globalThis.Worker; });
}

test('runAnalysis: uses the worker when there is one, and terminates it afterwards', async () => {
  const fake = { ok: true, result: { arch: { nodes: [], edges: [] }, validation: { errors: [], warnings: [] }, workspaces: [], depth: 7 } };
  await withFakeWorker((w) => w.onmessage({ data: { id: w.rec.received.id, ...fake } }), async (made) => {
    const r = await runAnalysis(input(), { worker: true });
    assert.equal(r.depth, 7, 'the worker\'s answer is used');
    assert.match(made[0].url, /analysis-worker\.mjs$/);
    assert.equal(made[0].opts.type, 'module');
    assert.equal(made[0].received.type, 'analyse');
    assert.ok(made[0].received.payload.contents instanceof Map, 'the downloaded files are handed over');
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
  await withFakeWorker((w) => w.onmessage({ data: { id: w.rec.received.id, ok: false, error: 'boom' } }), async () => {
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

// ---- the file tree is processed off the main thread too (#51) ----
const bigTree = (n) => JSON.stringify({ truncated: false, tree: [
  ...Array.from({ length: n }, (_, i) => ({ path: `packages/p${i % 20}/${i % 3 ? 'src' : '__tests__'}/f${i}.${i % 4 ? 'js' : 'md'}`, type: 'blob', size: 100 + i })),
  { path: 'packages', type: 'tree' }, { path: '.gitignore', type: 'blob', size: 5 }, { path: 'package.json', type: 'blob', size: 40 }, { path: 'README.md', type: 'blob', size: 40 }, { path: 'docker-compose.yml', type: 'blob', size: 40 },
] });

test('tree jobs: readTree keeps files and sorts them, planSources applies .gitignore and picks manifests, view files and sources', () => {
  const t = readTree(bigTree(200));
  assert.equal(t.truncated, false);
  assert.ok(t.allPaths.length === 204 && t.allPaths.every((p, i, a) => !i || a[i - 1] <= p), 'files only, sorted');
  assert.ok(!t.allPaths.includes('packages'));
  assert.deepEqual(t.sizes.find(([p]) => p === 'package.json'), ['package.json', 40]);
  const plan = planSources({ allPaths: t.allPaths, sizes: t.sizes, ignoreText: 'packages/p1/\n', sub: '', maxFiles: 25 });
  assert.ok(!plan.paths.some((p) => p.startsWith('packages/p1/')), '.gitignore is applied');
  assert.deepEqual(plan.manifests, ['package.json']);
  assert.equal(plan.readme, 'README.md');
  assert.deepEqual(plan.viewFiles, ['docker-compose.yml']);
  assert.equal(plan.chosen.length, 25);
  assert.ok(plan.total > 25 && plan.chosen.every((p) => /\.js$/.test(p) && !/__tests__/.test(p)), 'tests are not chosen');
  assert.ok(plan.skipped.tests > 0);
  assert.equal(planSources({ allPaths: t.allPaths, sizes: new Map(t.sizes), sub: 'nope' }).scopeEmpty, true, 'a folder that does not exist');
  assert.throws(() => readTree('not json'));
});

test('createRunner: tree, plan and analyse go to ONE worker, in order, with their own ids, and the worker is terminated at the end', async () => {
  const log = [];
  const answer = (w, m) => setTimeout(() => w.onmessage({ data: { id: m.id, ok: true, result: TASKS[m.type](m.payload) } }), 1);
  await withFakeWorker(() => {}, async (made) => {
    const r = createRunner({ worker: true });
    const tree = await r.run('tree', bigTree(30));
    const plan = await r.run('plan', { allPaths: tree.allPaths, sizes: tree.sizes, ignoreText: '', sub: '', maxFiles: 5 });
    assert.equal(plan.chosen.length, 5);
    const both = await Promise.all([r.run('tree', bigTree(3)), r.run('tree', bigTree(4))]);
    assert.deepEqual(both.map((t) => t.allPaths.length), [7, 8], 'answers are matched to requests by id');
    assert.deepEqual(log, ['tree', 'plan', 'tree', 'tree']);
    assert.equal(made.length, 1, 'one worker for the whole analysis');
    assert.equal(made[0].terminated, false);
    r.close();
    assert.equal(made[0].terminated, true);
  }, (w, m) => { log.push(m.type); answer(w, m); });
});

test('createRunner: when the worker cannot load, the jobs it was holding finish on this thread, and later ones run here', async () => {
  await withFakeWorker((w) => w.onerror({ preventDefault() {} }), async (made) => {
    const r = createRunner({ worker: true });
    const first = r.run('tree', bigTree(10));
    const t = await first;
    assert.equal(t.allPaths.length, 14);
    assert.equal((await r.run('tree', bigTree(5))).allPaths.length, 9);
    assert.equal(made[0].terminated, true);
    r.close();
  });
  await withFakeWorker((w) => w.onmessage({ data: { id: w.rec.received.id, ok: false, error: 'bad json' } }), async () => {
    await assert.rejects(() => createRunner({ worker: true }).run('tree', 'x'), /bad json/);
  });
});

test('createRunner: aborting rejects every pending job at once and stops the worker', async () => {
  const ctl = new AbortController();
  await withFakeWorker(() => {}, async (made) => {
    const r = createRunner({ worker: true, signal: ctl.signal });
    const jobs = [r.run('tree', bigTree(2)), r.run('tree', bigTree(3))];
    setTimeout(() => ctl.abort(), 10);
    for (const j of jobs) await assert.rejects(() => j, (e) => e.name === 'AbortError');
    assert.equal(made[0].terminated, true);
    await assert.rejects(() => r.run('tree', bigTree(1)), (e) => e.name === 'AbortError', 'and nothing new starts');
  });
  const already = new AbortController(); already.abort();
  await assert.rejects(() => createRunner({ worker: false, signal: already.signal }).run('tree', bigTree(1)), (e) => e.name === 'AbortError', 'also without a worker');
});

test('analyzeRepo: with a worker, the tree is parsed, filtered and chosen there, not on the calling thread; cancel still stops everything', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'api.github.com') {
      if (/\/commits\//.test(u.pathname)) return new Response('c'.repeat(40));
      return new Response(JSON.stringify({ truncated: false, tree: Object.keys(files).map((p) => ({ path: p, type: 'blob', size: files[p].length })) }));
    }
    const p = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
    return files[p] != null ? new Response(files[p]) : new Response('', { status: 404 });
  };
  const jobs = [];
  await withFakeWorker(() => {}, async (made) => {
    const r = await analyzeRepo({ owner: 'o', repo: 'w', ref: null }, { fetchImpl, worker: true });
    assert.deepEqual(jobs, ['tree', 'plan', 'analyse']);
    assert.deepEqual(r.validation.errors, []);
    assert.equal(r.meta.totalFiles, 4);
    assert.equal(made[0].terminated, true, 'the worker is released when the analysis ends');
  }, (w, m) => { jobs.push(m.type); setTimeout(() => w.onmessage({ data: { id: m.id, ok: true, result: TASKS[m.type](m.payload) } }), 1); });
  const ctl = new AbortController();
  await withFakeWorker(() => {}, async (made) => {
    const p = analyzeRepo({ owner: 'o', repo: 'w', ref: null }, { fetchImpl, worker: true, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    await assert.rejects(() => p, (e) => e.name === 'AbortError');
    assert.equal(made[0].terminated, true);
  });
});
