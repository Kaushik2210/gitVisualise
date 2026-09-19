import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeRepo, parseRepoInput, listRepos, GitHubError, pickSourceFiles } from '../skills/repo-architecture/scripts/lib/web/github-loader.mjs';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { renderPage, buildSnippets } from '../skills/repo-architecture/scripts/lib/core/build-core.mjs';

const SHA = 'a'.repeat(40);

function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gvweb-'));
  const w = (rel, txt) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), txt);
  };
  w('package.json', JSON.stringify({ name: 'demo', description: 'A demo service', main: 'src/server.js', dependencies: { express: '^4.0.0' } }, null, 2));
  w('.gitignore', 'dist/\n');
  w('src/server.js', `import express from 'express';\nimport { listUsers } from './services/users.js';\nconst app = express();\napp.get('/users', (req, res) => res.json(listUsers()));\napp.listen(3000);\n`);
  w('src/services/users.js', `import { db } from '../db/store.js';\nexport function listUsers() { return db.users; }\n`);
  w('src/db/store.js', `export const db = { users: [] };\n`);
  w('tests/users.test.js', `import { listUsers } from '../src/services/users.js';\n`);
  w('examples/demo.js', `console.log('example');\n`);
  w('dist/bundle.js', `/* ignored build output */\n`);
  for (const [rel, txt] of Object.entries(extra)) w(rel, txt);
  return root;
}

function listFiles(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(root, p) : [p];
  });
}

/** A fake api.github.com + raw.githubusercontent.com backed by a directory. Records every request. */
function fakeGithub(root, { rateLimited = false, missing = false } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    const u = new URL(url);
    if (missing) return new Response('{"message":"Not Found"}', { status: 404 });
    if (rateLimited) return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' } });
    if (u.hostname === 'api.github.com') {
      if (/\/commits\//.test(u.pathname)) return new Response(SHA, { status: 200, headers: { 'x-ratelimit-remaining': '58' } });
      if (/\/git\/trees\//.test(u.pathname)) {
        const tree = listFiles(root).map((p) => ({ path: p, type: 'blob', size: fs.statSync(path.join(root, p)).size }));
        return new Response(JSON.stringify({ sha: SHA, tree, truncated: false }), { status: 200 });
      }
      const contents = u.pathname.match(/\/contents\/(.+)$/);
      if (contents) return new Response(fs.readFileSync(path.join(root, decodeURIComponent(contents[1])), 'utf8'), { status: 200 });
      if (/\/users\/.+\/repos$/.test(u.pathname)) return new Response(JSON.stringify([{ full_name: 'o/a', name: 'a', description: 'A', language: 'JavaScript', stargazers_count: 3, pushed_at: '2026-01-01T00:00:00Z' }]), { status: 200 });
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      const rel = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
      const abs = path.join(root, rel);
      return fs.existsSync(abs) ? new Response(fs.readFileSync(abs, 'utf8'), { status: 200 }) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  };
  return { impl, calls };
}

test('parseRepoInput: URLs, shorthand, refs, and rejects non-GitHub input', () => {
  const ok = (s, want) => assert.deepEqual(parseRepoInput(s), want, s);
  ok('tj/commander.js', { owner: 'tj', repo: 'commander.js', ref: null });
  ok('https://github.com/tj/commander.js', { owner: 'tj', repo: 'commander.js', ref: null });
  ok('https://github.com/tj/commander.js.git', { owner: 'tj', repo: 'commander.js', ref: null });
  ok('github.com/psf/requests/', { owner: 'psf', repo: 'requests', ref: null });
  ok('https://github.com/o/r/tree/dev/src/x', { owner: 'o', repo: 'r', ref: 'dev' });
  ok('git@github.com:o/r.git', { owner: 'o', repo: 'r', ref: null });
  ok('o/r@v2', { owner: 'o', repo: 'r', ref: 'v2' });
  ok('  https://github.com/o/r?tab=readme  ', { owner: 'o', repo: 'r', ref: null });
  for (const bad of ['', 'hello', 'https://gitlab.com/o/r', 'o/r/extra', '../x', 'a b']) assert.equal(parseRepoInput(bad), null, bad);
});

test('analyzeRepo: analyses a GitHub repo with no server, pins the commit, skips tests/examples/ignored', async () => {
  const root = fixture();
  const gh = fakeGithub(root);
  const events = [];
  const res = await analyzeRepo('o/r', { fetchImpl: gh.impl, onProgress: (e) => events.push(e.stage) });

  assert.deepEqual(res.validation.errors, []);
  assert.equal(res.meta.curated, false);
  assert.equal(res.meta.sha, SHA);
  assert.equal(res.arch.project.repoUrl, 'https://github.com/o/r');
  assert.equal(res.arch.project.commit, SHA);
  const files = res.arch.nodes.flatMap((n) => n.sources.map((s) => s.path));
  assert.ok(files.includes('src/server.js'));
  assert.ok(!files.some((p) => p.startsWith('tests/') || p.startsWith('examples/') || p.startsWith('dist/')));
  assert.match(res.arch.project.notes.join(' '), /1 tests file/);
  assert.match(res.arch.project.notes.join(' '), /1 examples file/);
  assert.ok(res.arch.nodes.some((n) => n.label === 'express' && n.external));
  assert.ok(['resolve', 'tree', 'download', 'analyse'].every((s) => events.includes(s)));
  // never downloads ignored/test/example files
  assert.ok(!gh.calls.some((c) => /dist\/bundle|tests\/users|examples\/demo/.test(c.url)));
  // exactly two API calls (commit + tree); everything else is raw.githubusercontent.com
  assert.equal(gh.calls.filter((c) => c.url.startsWith('https://api.github.com')).length, 2);
});

test('analyzeRepo: matches the CLI scanner on the same repo (one implementation, two front ends)', async () => {
  const root = fixture();
  const cli = generate(scanRepo(root));
  const web = (await analyzeRepo('o/r', { fetchImpl: fakeGithub(root).impl })).arch;
  const sig = (a) => a.nodes.map((n) => `${n.id}:${n.kind}`).sort().join('|') + '#' + a.edges.map((e) => `${e.from}>${e.to}`).sort().join('|');
  assert.equal(sig(web), sig(cli));
});

test('analyzeRepo: prefers the tour the repo authors published, and flags stale references', async () => {
  const root = fixture();
  const authored = generate(scanRepo(root));
  authored.project.description = 'Hand-written description by the authors';
  fs.mkdirSync(path.join(root, 'docs/architecture'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/architecture/architecture.json'), JSON.stringify(authored));
  const res = await analyzeRepo('o/r', { fetchImpl: fakeGithub(root).impl });
  assert.equal(res.meta.curated, true);
  assert.equal(res.arch.project.description, 'Hand-written description by the authors');
  assert.equal(res.arch.project.commit, SHA); // links are re-pinned to the analysed commit
  assert.deepEqual(res.validation.errors, []);

  // a reference to a file that no longer exists must be reported
  authored.nodes[0].sources = [{ path: 'src/gone.js' }];
  fs.writeFileSync(path.join(root, 'docs/architecture/architecture.json'), JSON.stringify(authored));
  const stale = await analyzeRepo('o/r', { fetchImpl: fakeGithub(root).impl });
  assert.ok(stale.validation.errors.some((e) => /gone\.js/.test(e)));

  // and the user can opt out of the curated tour
  const fresh = await analyzeRepo('o/r', { fetchImpl: fakeGithub(root).impl, preferCurated: false });
  assert.equal(fresh.meta.curated, false);
});

test('analyzeRepo: friendly typed errors for 404, rate limits and bad input', async () => {
  const root = fixture();
  await assert.rejects(analyzeRepo('o/r', { fetchImpl: fakeGithub(root, { missing: true }).impl }), (e) => e instanceof GitHubError && e.kind === 'not_found');
  await assert.rejects(analyzeRepo('o/r', { fetchImpl: fakeGithub(root, { rateLimited: true }).impl }), (e) => e.kind === 'rate_limit' && e.resetAt instanceof Date);
  await assert.rejects(analyzeRepo('not a repo', {}), (e) => e.kind === 'bad_input');
  await assert.rejects(analyzeRepo('o/r', { fetchImpl: async () => { throw new TypeError('offline'); } }), (e) => e.kind === 'network');
});

test('analyzeRepo: with a token it authenticates and reads files through the contents API', async () => {
  const root = fixture();
  const gh = fakeGithub(root);
  await analyzeRepo('o/r', { fetchImpl: gh.impl, token: 'ghp_test' });
  assert.ok(gh.calls.every((c) => !c.url.includes('raw.githubusercontent.com')), 'no raw host when a token is used');
  assert.ok(gh.calls.filter((c) => c.url.includes('/contents/')).length > 0);
  assert.ok(gh.calls.filter((c) => c.url.startsWith('https://api.github.com')).every((c) => c.headers.Authorization === 'Bearer ghp_test'));
});

test('listRepos: needs a user or a token, and maps the API shape', async () => {
  const gh = fakeGithub(fixture());
  const repos = await listRepos({ user: 'o', fetchImpl: gh.impl });
  assert.deepEqual(repos[0], { fullName: 'o/a', name: 'a', description: 'A', language: 'JavaScript', stars: 3, updated: '2026-01-01T00:00:00Z', private: false, fork: false });
  await assert.rejects(listRepos({ fetchImpl: gh.impl }), (e) => e.kind === 'bad_input');
});

test('pickSourceFiles: prefers shallow entry-like files and reports what it skipped', () => {
  const paths = ['a/b/c/deep.js', 'index.js', 'src/x.js', 'tests/t.test.js', 'examples/e.js', 'vite.config.js', 'README.md'];
  const sizes = new Map(paths.map((p) => [p, 100]));
  const r = pickSourceFiles(paths, sizes, 2);
  assert.deepEqual(r.chosen, ['index.js', 'src/x.js']);
  assert.equal(r.total, 3);
  assert.deepEqual(r.skipped, { tests: 1, examples: 1, tooling: 1 });
});

test('renderPage inline mode produces one self-contained file', async () => {
  const root = fixture();
  const res = await analyzeRepo('o/r', { fetchImpl: fakeGithub(root).impl });
  const viewerDir = path.resolve('skills/repo-architecture/viewer');
  const template = fs.readFileSync(path.join(viewerDir, 'index.template.html'), 'utf8');
  const html = renderPage({ arch: res.arch, snippets: buildSnippets(res.arch, res.view), template, inline: { css: fs.readFileSync(path.join(viewerDir, 'viewer.css'), 'utf8'), js: fs.readFileSync(path.join(viewerDir, 'viewer.js'), 'utf8') } });
  assert.ok(!html.includes('href="viewer.css"') && !html.includes('src="viewer.js"'), 'no external assets');
  assert.ok(html.includes('<style>') && html.includes('function computeLayout'));
  assert.ok(Object.keys(JSON.parse(html.match(/<script id="arch-data"[^>]*>([\s\S]*?)<\/script>/)[1]).snippets).length > 0);
});

test('website: the tour frame is always mounted fresh, never navigated in place', () => {
  // Regression guard. Assigning srcdoc to a long-lived frame in the same task that un-hides its container can leave
  // the sandboxed document without a layout (a blank tour). Only mountFrame() may create or load the frame.
  const app = fs.readFileSync(path.resolve('site/app.js'), 'utf8');
  assert.ok(/function mountFrame\(/.test(app), 'mountFrame exists');
  assert.ok(!/\$\('frame'\)\.srcdoc/.test(app), 'no direct srcdoc assignment on the shared frame');
  const assignments = app.match(/\.srcdoc\s*=/g) || [];
  assert.equal(assignments.length, 1, 'srcdoc is assigned in exactly one place (mountFrame)');
  assert.match(app, /sandbox['"], 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads'/, 'every mounted frame stays sandboxed (downloads only)');
  assert.ok(!/allow-same-origin/.test(app), 'the frame must never get same-origin access');
});
