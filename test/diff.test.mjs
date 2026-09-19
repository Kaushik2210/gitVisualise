// Architecture diff: two revisions of a repository compared by node and edge id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diffArchitectures } from '../skills/repo-architecture/scripts/lib/core/diff-core.mjs';
import { compareRepos, parseRepoInput } from '../skills/repo-architecture/scripts/lib/web/github-loader.mjs';
import { keyOf } from '../skills/repo-architecture/scripts/lib/web/route.mjs';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { repo } from './helpers.mjs';

const BASE = { 'package.json': '{"name":"app","main":"main.js"}', 'main.js': "import { a } from './a.js';\nimport { b } from './b.js';\n", 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 2;\n' };
// head: b.js removed, c.js added, a.js changed (now imports c.js)
const HEAD = { 'package.json': '{"name":"app","main":"main.js"}', 'main.js': "import { a } from './a.js';\n", 'a.js': "import { c } from './c.js';\nexport const a = c;\n", 'c.js': 'export const c = 3;\n' };
const arch = (files) => generate(scanRepo(repo(files)));
const byId = (a) => Object.fromEntries(a.nodes.map((n) => [n.id, n]));

test('diff: nodes and edges are marked added, removed, changed or same by id', () => {
  const { arch: d, summary } = diffArchitectures(arch(BASE), arch(HEAD), { baseRef: 'v1', headRef: 'v2', baseCommit: 'b'.repeat(40) });
  const n = byId(d);
  assert.equal(n['b-js'].diff, 'removed');
  assert.equal(n['c-js'].diff, 'added');
  assert.equal(n['a-js'].diff, 'changed');
  assert.match(n['a-js'].diffNote, /Before:/);
  assert.equal(n['main-js'].diff, 'changed'); // it lost an import, so its description changed
  const e = Object.fromEntries(d.edges.map((x) => [x.id, x.diff]));
  assert.equal(e['e-a-js--c-js'], 'added');
  assert.equal(e['e-main-js--b-js'], 'removed');
  assert.deepEqual(summary.nodes, { added: 1, removed: 1, changed: 2 });
  assert.equal(summary.empty, false);
});

test('diff: removed items keep their evidence but pinned to the base commit, and the result validates', () => {
  const root = repo(HEAD);
  const head = generate(scanRepo(root));
  const { arch: d } = diffArchitectures(arch(BASE), head, { baseRef: 'v1', headRef: 'v2', baseCommit: 'c'.repeat(40) });
  const removed = d.nodes.find((x) => x.diff === 'removed');
  assert.ok(removed.sources.length && removed.sources.every((s) => s.commit === 'c'.repeat(40)));
  assert.ok(d.edges.filter((x) => x.diff === 'removed').every((x) => x.sources.every((s) => s.commit)));
  assert.deepEqual(validate(d, root).errors, []);
  assert.equal(d.flows[0].id, 'what-changed');
  assert.match(d.flows[0].steps[0].narration, /1 component added, 1 removed and 2 changed/);
  assert.ok(d.flows[0].steps.some((s) => /^Removed components/.test(s.title)));
  assert.deepEqual(d.project.compare.base, { ref: 'v1', commit: 'c'.repeat(40) });
});

test('diff: identical revisions produce no changes and keep the original flows', () => {
  const a = arch(HEAD);
  const { arch: d, summary } = diffArchitectures(a, JSON.parse(JSON.stringify(a)));
  assert.equal(summary.empty, true);
  assert.ok(d.nodes.every((x) => x.diff === 'same') && d.edges.every((x) => x.diff === 'same'));
  assert.ok(!d.flows.some((f) => f.id === 'what-changed'));
});

test('diff: the validator rejects a bogus diff value', () => {
  const root = repo(HEAD);
  const a = generate(scanRepo(root));
  a.nodes[0].diff = 'moved';
  assert.ok(validate(a, root).errors.some((e) => /diff must be/.test(e)));
});

test('parseRepoInput: comparison ranges and GitHub compare URLs', () => {
  assert.deepEqual(parseRepoInput('o/r@v1...v2'), { owner: 'o', repo: 'r', ref: 'v2', base: 'v1' });
  assert.deepEqual(parseRepoInput('o/r@main...'), { owner: 'o', repo: 'r', ref: null, base: 'main' });
  assert.deepEqual(parseRepoInput('https://github.com/o/r/compare/v1...v2'), { owner: 'o', repo: 'r', ref: 'v2', base: 'v1' });
  assert.deepEqual(parseRepoInput('o/r@a...b:pkg/x'), { owner: 'o', repo: 'r', ref: 'b', base: 'a', path: 'pkg/x' });
  assert.equal(keyOf(parseRepoInput('o/r@a...b')), 'o/r@a...b');
  assert.equal(keyOf(parseRepoInput('o/r@a...')), 'o/r@a...');
});

// A fake GitHub with one directory per ref; each ref resolves to its own commit.
function fakeByRef(roots) {
  const shas = Object.fromEntries(Object.keys(roots).map((r, i) => [r, String(i + 1).repeat(40)]));
  const rootOfSha = Object.fromEntries(Object.entries(shas).map(([r, s]) => [s, roots[r]]));
  const list = (root, rel = '') => fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(root, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]));
  const impl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'api.github.com') {
      const c = u.pathname.match(/\/commits\/(.+)$/);
      if (c) return shas[decodeURIComponent(c[1])] ? new Response(shas[decodeURIComponent(c[1])], { status: 200 }) : new Response('{}', { status: 404 });
      const t = u.pathname.match(/\/git\/trees\/(\w+)/);
      if (t) return new Response(JSON.stringify({ tree: list(rootOfSha[t[1]]).map((p) => ({ path: p, type: 'blob', size: fs.statSync(path.join(rootOfSha[t[1]], p)).size })), truncated: false }), { status: 200 });
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      const [, , , sha, ...rest] = u.pathname.split('/');
      const abs = path.join(rootOfSha[sha], decodeURIComponent(rest.join('/')));
      return fs.existsSync(abs) ? new Response(fs.readFileSync(abs, 'utf8'), { status: 200 }) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  };
  return { impl, shas };
}

test('compareRepos: analyses both refs from GitHub and returns a validated comparison', async () => {
  const { impl, shas } = fakeByRef({ v1: repo(BASE), v2: repo(HEAD) });
  const res = await compareRepos(parseRepoInput('o/r@v1...v2'), { fetchImpl: impl });
  assert.deepEqual(res.validation.errors, []);
  assert.equal(res.meta.sha, shas.v2);
  assert.equal(res.meta.compare.baseSha, shas.v1);
  assert.deepEqual(res.meta.compare.summary.nodes, { added: 1, removed: 1, changed: 2 });
  assert.equal(res.arch.flows[0].id, 'what-changed');
  const removed = res.arch.nodes.find((n) => n.diff === 'removed');
  assert.ok(removed.sources.every((s) => s.commit === shas.v1));
  await assert.rejects(() => compareRepos({ owner: 'o', repo: 'r', ref: 'v2' }, { fetchImpl: impl }), /two revisions/);
});

test('cli: `diff` writes a merged architecture.json and a page that validates against the newer checkout', () => {
  const baseRoot = repo(BASE), headRoot = repo(HEAD);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gvdiff-'));
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills/repo-architecture/scripts/gitvisualise.mjs');
  const gen = (root) => {
    const o = fs.mkdtempSync(path.join(os.tmpdir(), 'gvgen-'));
    fs.writeFileSync(path.join(o, 'architecture.json'), JSON.stringify(generate(scanRepo(root))));
    return o;
  };
  const stdout = execFileSync('node', [cli, 'diff', gen(baseRoot), gen(headRoot), '--out', out, '--root', headRoot, '--base-ref', 'v1', '--head-ref', 'v2'], { encoding: 'utf8' });
  assert.match(stdout, /Components: \+1 -1 ~2/);
  const d = JSON.parse(fs.readFileSync(path.join(out, 'architecture.json'), 'utf8'));
  assert.equal(d.project.compare.base.ref, 'v1');
  assert.ok(fs.existsSync(path.join(out, 'index.html')));
});
