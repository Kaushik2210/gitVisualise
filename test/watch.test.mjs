// `gitvisualise watch`: which changes trigger a rebuild, and an end-to-end run against a real folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyChange, debounce } from '../skills/repo-architecture/scripts/lib/watch.mjs';
import { repo } from './helpers.mjs';

test('watch: source changes trigger, noise and generated folders do not', () => {
  const c = (p, o) => classifyChange(p, { outRel: 'docs/architecture', ...o });
  assert.equal(c('src/app.js'), 'source');
  assert.equal(c('src\\util\\x.py'), 'source', 'Windows separators');
  assert.equal(c('node_modules/x/index.js'), 'ignore');
  assert.equal(c('.git/index'), 'ignore');
  assert.equal(c('.gitvisualise/scan.json'), 'ignore');
  assert.equal(c('src/.#lock.js'), 'ignore');
  assert.equal(c('src/app.js~'), 'ignore');
  assert.equal(c('src/.app.js.swp'), 'ignore');
  assert.equal(c(''), 'ignore');
});

test('watch: our own output never triggers a rebuild, but a later hand edit of architecture.json does', () => {
  const o = { outRel: 'docs/architecture' };
  assert.equal(classifyChange('docs/architecture/index.html', o), 'ignore');
  assert.equal(classifyChange('docs/architecture/viewer.js', o), 'ignore');
  assert.equal(classifyChange('docs/architecture/architecture.json', { ...o, recentBuild: true }), 'ignore', 'written by the build that just ran');
  assert.equal(classifyChange('docs/architecture/architecture.json', { ...o, recentBuild: false }), 'architecture');
  assert.equal(classifyChange('docs/other.md', o), 'source');
});

test('watch: debounce coalesces a burst into one call', async () => {
  const seen = [];
  const d = debounce((x) => seen.push(x), 30);
  d(1); d(2); d(3);
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(seen, [3]);
  d(4); d.cancel();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, [3]);
  d.flush(5);
  assert.deepEqual(seen, [3, 5]);
});

test('watch: rebuilds after a source edit and after a hand edit of architecture.json, without looping', async () => {
  const root = repo({ 'package.json': '{"name":"w","main":"a.js"}', 'a.js': "import './b.js';\n", 'b.js': 'export const b = 1;\n' });
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills/repo-architecture/scripts/gitvisualise.mjs');
  const child = spawn('node', [cli, 'watch', root, '--debounce', '60'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const until = async (re, ms = 12000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (re.test(out)) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`timed out waiting for ${re}\n--- output ---\n${out}`);
  };
  try {
    await until(/rebuilt \(source changed\)/);
    const archFile = path.join(root, 'docs', 'architecture', 'architecture.json');
    assert.ok(fs.existsSync(archFile), 'first build wrote the tour');
    const before = (out.match(/rebuilt/g) || []).length;

    // let the build settle, then edit a source file
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(root, 'c.js'), "import './b.js';\n");
    await until(new RegExp(`(rebuilt[^]*){${before + 1}}`));
    const arch = JSON.parse(fs.readFileSync(archFile, 'utf8'));
    assert.ok(arch.nodes.some((n) => /c\.js/.test(n.label)), 'the new file is in the regenerated tour');

    // a hand edit of architecture.json only rebuilds (curated text is not overwritten)
    await new Promise((r) => setTimeout(r, 1100));
    arch.nodes[0].summary = 'Hand written summary.';
    arch.nodes[0].origin = 'manual';
    fs.writeFileSync(archFile, JSON.stringify(arch, null, 2));
    await until(/rebuilt \(architecture\.json edited\)/);
    assert.match(fs.readFileSync(path.join(root, 'docs', 'architecture', 'index.html'), 'utf8'), /Hand written summary\./);

    // quiet period: our own writes must not cause another rebuild
    const count = (out.match(/rebuilt/g) || []).length;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((out.match(/rebuilt/g) || []).length, count, 'no rebuild loop');
  } finally {
    child.kill();
  }
});
