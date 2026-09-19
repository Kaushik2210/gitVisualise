import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { mergeArchitecture } from '../skills/repo-architecture/scripts/lib/merge.mjs';
import { build } from '../skills/repo-architecture/scripts/lib/build.mjs';
import { parseTarget } from '../skills/repo-architecture/scripts/lib/github.mjs';

const VIEWER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/repo-architecture/viewer');

/** Builds a tiny Express-style repo in a temp dir. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-'));
  const w = (rel, txt) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), txt);
  };
  w('package.json', JSON.stringify({ name: 'demo', description: 'A demo service', main: 'src/server.js', dependencies: { express: '^4.0.0', axios: '^1.0.0' } }, null, 2));
  w('src/server.js', `/** HTTP entry point of the demo service. */\nimport express from 'express';\nimport { listUsers } from './services/users.js';\nconst app = express();\napp.get('/users', (req, res) => res.json(listUsers()));\napp.listen(3000);\n`);
  w('src/services/users.js', `import { db } from '../db/store.js';\nexport function listUsers() { return db.users; }\n`);
  w('src/db/store.js', `export const db = { users: [] };\n`);
  w('src/client.js', `import axios from 'axios';\nconst api = axios.create({ baseURL: '/x' });\nexport const getThing = () => api.get('/thing');\n`);
  w('node_modules/junk/index.js', `export const x = 1;\n`);
  w('tests/users.test.js', `import { listUsers } from '../src/services/users.js';\n`);
  return root;
}

test('scan: resolves imports, finds entry, ignores node_modules, no false routes', () => {
  const root = fixture();
  const scan = scanRepo(root);
  const paths = scan.files.map((f) => f.path);
  assert.ok(!paths.some((p) => p.includes('node_modules')));
  assert.ok(scan.entryPoints.some((e) => e.path === 'src/server.js'));
  const server = scan.files.find((f) => f.path === 'src/server.js');
  assert.equal(server.imports.find((i) => i.spec === './services/users.js').resolved, 'src/services/users.js');
  assert.deepEqual(scan.routes.map((r) => `${r.method} ${r.path}`), ['GET /users']); // real server route only
  assert.ok(!scan.routes.some((r) => r.file === 'src/client.js'), 'axios client call must not be reported as a route');
  assert.ok(scan.externals.some((e) => e.name === 'express'));
});

test('generate -> validate passes and every edge has evidence', () => {
  const root = fixture();
  const arch = generate(scanRepo(root));
  const r = validate(arch, root);
  assert.deepEqual(r.errors, []);
  assert.ok(arch.edges.every((e) => e.sources.length > 0));
  assert.ok(arch.flows[0].steps.every((s) => s.narration.length > 10));
});

test('validate rejects invented files, bad line ranges, dangling refs and hallucinated paths in prose', () => {
  const root = fixture();
  const arch = generate(scanRepo(root));
  const bad = structuredClone(arch);
  bad.nodes[0].sources = [{ path: 'src/does-not-exist.js' }];
  bad.nodes[1].sources = [{ path: 'src/db/store.js', lines: [1, 999] }];
  bad.flows[0].steps[0].nodes = ['ghost-node'];
  bad.flows[0].steps[1].narration = 'It then calls `src/services/made-up.js` to do the work.';
  bad.edges[0].to = 'ghost-target';
  const r = validate(bad, root);
  const all = r.errors.join('\n');
  assert.match(all, /does not exist in the repository/);
  assert.match(all, /exceed/);
  assert.match(all, /ghost-node/);
  assert.match(all, /made-up\.js/);
  assert.match(all, /ghost-target/);
});

test('validate is case-exact (GitHub is case-sensitive)', () => {
  const root = fixture();
  const arch = generate(scanRepo(root));
  arch.nodes[0].sources = [{ path: 'SRC/server.js' }];
  assert.match(validate(arch, root).errors.join('\n'), /does not exist/);
});

test('merge keeps claude/manual/locked content and drops removed auto items', () => {
  const root = fixture();
  const fresh = generate(scanRepo(root));
  const existing = structuredClone(fresh);
  existing.nodes[0] = { ...existing.nodes[0], origin: 'claude', summary: 'Curated by Claude', label: 'Curated' };
  existing.nodes[1] = { ...existing.nodes[1], locked: ['summary'], summary: 'Human wording', position: { x: 5, y: 6 } };
  existing.nodes.push({ id: 'manual-node', label: 'Manual', kind: 'module', origin: 'manual', sources: [{ path: 'package.json' }] });
  existing.nodes.push({ id: 'stale-auto', label: 'Stale', kind: 'module', origin: 'auto', sources: [{ path: 'package.json' }] });
  const { arch, report } = mergeArchitecture(existing, fresh);
  const byId = Object.fromEntries(arch.nodes.map((n) => [n.id, n]));
  assert.equal(byId[fresh.nodes[0].id].summary, 'Curated by Claude');
  assert.equal(byId[fresh.nodes[1].id].summary, 'Human wording');
  assert.deepEqual(byId[fresh.nodes[1].id].position, { x: 5, y: 6 });
  assert.ok(byId['manual-node']);
  assert.ok(!byId['stale-auto']);
  assert.ok(report.dropped.includes('node stale-auto'));
  // second merge is stable (idempotent)
  const again = mergeArchitecture(arch, fresh).arch;
  assert.deepEqual(again.nodes.map((n) => n.id), arch.nodes.map((n) => n.id));
});

test('build: writes a static site and neutralises </script> in repo-derived text', () => {
  const root = fixture();
  const arch = generate(scanRepo(root));
  arch.nodes[0].summary = 'Evil </script><img src=x onerror=alert(1)> text';
  const out = path.join(root, 'site');
  const res = build({ arch, root, outDir: out, viewerDir: VIEWER });
  assert.ok(res.snippets > 0);
  for (const f of ['index.html', 'viewer.js', 'viewer.css']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.equal((html.match(/<\/script>/g) || []).length, 3, 'only the 3 real script tags may close');
  assert.ok(!html.includes('<img src=x'), 'static fallback must be HTML-escaped');
  const json = html.match(/<script id="arch-data"[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).arch.nodes[0].summary, arch.nodes[0].summary, 'data round-trips');
});

test('parseTarget understands GitHub URLs, shorthand and local paths', () => {
  assert.deepEqual(parseTarget('https://github.com/o/r.git'), { type: 'github', owner: 'o', repo: 'r', ref: null, url: 'https://github.com/o/r' });
  assert.equal(parseTarget('https://github.com/o/r/tree/dev/src').ref, 'dev');
  assert.equal(parseTarget('git@github.com:o/r.git').repo, 'r');
  assert.equal(parseTarget('github:o/r').owner, 'o');
  assert.equal(parseTarget('.').type, 'local');
});

test('Go: a package (directory) is one node, imports resolve across packages, no false validator warnings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-go-'));
  const w = (rel, txt) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), txt);
  };
  w('go.mod', 'module example.com/demo\n\ngo 1.21\n\nrequire github.com/rivo/uniseg v0.4.7\n');
  w('main.go', 'package main\n\nimport (\n\t"fmt"\n\t"example.com/demo/internal/util"\n\t"github.com/rivo/uniseg"\n)\n\nfunc main() { fmt.Println(util.Hello(), uniseg.GraphemeClusterCount("x")) }\n');
  w('internal/util/hello.go', 'package util\n\nfunc Hello() string { return "hi" }\n');
  w('internal/util/bye.go', 'package util\n\nfunc Bye() string { return "bye" }\n');
  const arch = generate(scanRepo(root));
  const labels = arch.nodes.map((n) => n.label);
  assert.ok(labels.includes('util/'), 'both util files collapse into one package node');
  assert.equal(arch.nodes.filter((n) => !n.external).length, 2, 'root package + util package');
  assert.ok(arch.edges.some((e) => e.kind === 'imports' && /util/.test(e.to)), 'main -> util import edge');
  assert.ok(arch.nodes.some((n) => n.external && n.label === 'github.com/rivo/uniseg'));
  const r = validate(arch, root);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, [], 'Go import-block lines and module paths must not raise warnings');
});
