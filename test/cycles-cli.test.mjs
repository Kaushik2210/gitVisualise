// `gitvisualise cycles`: lists loops, writes nothing into the repository, and can fail a CI job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cycleReport } from '../skills/repo-architecture/scripts/lib/core/cycles-core.mjs';
import { repo } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills/repo-architecture/scripts/gitvisualise.mjs');
const run = (...args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
const looped = () => repo({
  'package.json': '{"name":"d","main":"src/index.js"}',
  'src/index.js': "import './a.js';\n",
  'src/a.js': "import './b.js';\n",
  'src/b.js': "import './a.js';\n",
});
const clean = () => repo({ 'package.json': '{"name":"d","main":"src/index.js"}', 'src/index.js': "import './a.js';\n", 'src/a.js': 'export const a = 1;\n' });

test('cycles command: lists each loop with the import that closes it, and exits 0 by default', () => {
  const root = looped();
  const r = run('cycles', root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 circular dependency/);
  assert.match(r.stdout, /a\.js → b\.js → a\.js|b\.js → a\.js → b\.js/);
  assert.match(r.stdout, /closes at src\/[ab]\.js:1/);
});

test('cycles command: --fail-on-cycles exits 1 for a loop and 0 for none', () => {
  assert.equal(run('cycles', looped(), '--fail-on-cycles').status, 1);
  const ok = run('cycles', clean(), '--fail-on-cycles');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /No circular dependencies found/);
});

test('cycles command: --json is machine-readable and the run writes nothing into the repository', () => {
  const root = looped();
  const before = fs.readdirSync(root).sort();
  const r = run('cycles', root, '--json');
  const loops = JSON.parse(r.stdout);
  assert.equal(loops.length, 1);
  assert.deepEqual(Object.keys(loops[0]).sort(), ['components', 'evidence', 'loop', 'title']);
  assert.ok(loops[0].evidence.path.startsWith('src/') && loops[0].evidence.line === 1);
  assert.deepEqual(fs.readdirSync(root).sort(), before, 'no .gitvisualise, no docs');
});

test('cycleReport: an architecture without a cycles flow reports nothing', () => {
  assert.deepEqual(cycleReport({ nodes: [], flows: [{ id: 'startup', steps: [] }] }), []);
  assert.deepEqual(cycleReport({}), []);
});
