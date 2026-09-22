// `gitvisualise init`: generates the tour, adds the Action workflow (once), and prints the badge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills/repo-architecture/scripts/gitvisualise.mjs');
const WORKFLOW = '.github/workflows/architecture.yml';

function gitRepo(remote) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-init-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  if (remote) execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"widget","main":"src/main.js"}');
  fs.writeFileSync(path.join(root, 'src/main.js'), 'console.log(1);\n');
  return root;
}
const run = (root, args) => execFileSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });

test('init: generates the tour, writes the Action workflow, and prints the badge for a repo with a GitHub remote', () => {
  const root = gitRepo('https://github.com/acme/widget.git');
  const out = run(root, ['init', '.']);
  assert.ok(fs.existsSync(path.join(root, 'docs/architecture/architecture.json')));
  assert.ok(fs.existsSync(path.join(root, 'docs/architecture/index.html')));
  assert.ok(fs.existsSync(path.join(root, WORKFLOW)));
  assert.match(out, /\[!\[Architecture tour\]\(https:\/\/img\.shields\.io\/badge\/architecture-tour[^)]+\)\]\(https:\/\/kaushik2210\.github\.io\/gitVisualise\/#\/acme\/widget\)/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('init: without a GitHub remote, still builds the tour and says it cannot make a badge', () => {
  const root = gitRepo(null);
  const out = run(root, ['init', '.']);
  assert.ok(fs.existsSync(path.join(root, 'docs/architecture/architecture.json')));
  assert.match(out, /Could not tell which GitHub repository this is/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('init: is idempotent — a second run leaves an existing workflow file byte-for-byte untouched', () => {
  const root = gitRepo('https://github.com/acme/widget.git');
  run(root, ['init', '.']);
  const before = fs.readFileSync(path.join(root, WORKFLOW), 'utf8');
  const out = run(root, ['init', '.']);
  const after = fs.readFileSync(path.join(root, WORKFLOW), 'utf8');
  assert.equal(before, after);
  assert.match(out, /Already exists — left untouched/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('init: never overwrites a workflow file that already exists, even a hand-written one', () => {
  const root = gitRepo('https://github.com/acme/widget.git');
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, WORKFLOW), '# hand-written, keep me\n');
  run(root, ['init', '.']);
  assert.equal(fs.readFileSync(path.join(root, WORKFLOW), 'utf8'), '# hand-written, keep me\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('init: the workflow it writes matches the snippet in guides/publish-your-tour.md exactly', () => {
  const guide = fs.readFileSync(new URL('../guides/publish-your-tour.md', import.meta.url), 'utf8');
  const m = /```yaml\n( *name: Architecture tour\n[\s\S]*?\n) *```/.exec(guide);
  assert.ok(m, 'could not find the workflow snippet in the guide');
  const root = gitRepo('https://github.com/acme/widget.git');
  run(root, ['init', '.']);
  const written = fs.readFileSync(path.join(root, WORKFLOW), 'utf8');
  assert.equal(written, m[1].replace(/^ {3}/gm, ''), 'gitvisualise init wrote something different from the guide');
  fs.rmSync(root, { recursive: true, force: true });
});

test('init --dry-run: writes nothing at all', () => {
  const root = gitRepo('https://github.com/acme/widget.git');
  const out = run(root, ['init', '.', '--dry-run']);
  assert.ok(!fs.existsSync(path.join(root, 'docs')));
  assert.ok(!fs.existsSync(path.join(root, '.github')));
  assert.match(out, /dry run: nothing will be written/);
  assert.match(out, /Would write it/);
  assert.match(out, /acme\/widget/);
  fs.rmSync(root, { recursive: true, force: true });
});
