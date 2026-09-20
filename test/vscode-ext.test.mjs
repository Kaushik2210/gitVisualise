// The VS Code extension's pure helpers: what a webview message may open, and how the tour page is prepared for a webview.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { resolveInside, lineRange, prepareWebviewHtml, randomNonce } = createRequire(import.meta.url)('../vscode-extension/lib.js');

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gvvs-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), '1;\n');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside\n');
  return { base, root };
}

test('resolveInside: only existing paths inside the workspace resolve', () => {
  const { base, root } = workspace();
  assert.equal(resolveInside(root, 'src/a.js'), fs.realpathSync(path.join(root, 'src', 'a.js')));
  assert.equal(resolveInside(root, 'src\\a.js'), fs.realpathSync(path.join(root, 'src', 'a.js')), 'Windows separators');
  assert.equal(resolveInside(root, 'src'), fs.realpathSync(path.join(root, 'src')), 'a directory');
  assert.equal(resolveInside(root, 'src/missing.js'), null, 'must exist');
  fs.rmSync(base, { recursive: true, force: true });
});

test('resolveInside: everything that could leave the workspace, or is not a plain path, is refused', () => {
  const { base, root } = workspace();
  const bad = ['../secret.txt', 'src/../../secret.txt', '..', '..\\secret.txt', '/etc/hosts', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini', '\\\\server\\share\\x', '//server/share/x',
    'file:///etc/hosts', 'vscode://x', 'src/a.js\0', '', null, undefined, 42, {}, [], 'x'.repeat(2000)];
  for (const p of bad) assert.equal(resolveInside(root, p), null, JSON.stringify(p));
  assert.equal(resolveInside(path.join(base, 'nope'), 'src/a.js'), null, 'a workspace that does not exist');
  fs.rmSync(base, { recursive: true, force: true });
});

test('resolveInside: a symlink that points outside the workspace is refused too', (t) => {
  const { base, root } = workspace();
  try { fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'src', 'link.txt')); }
  catch { t.skip('symlinks are not available on this system'); fs.rmSync(base, { recursive: true, force: true }); return; }
  assert.equal(resolveInside(root, 'src/link.txt'), null);
  fs.rmSync(base, { recursive: true, force: true });
});

test('lineRange: a well-formed 1-based range or nothing', () => {
  assert.deepEqual(lineRange([3, 9]), [3, 9]);
  assert.deepEqual(lineRange([5, 5]), [5, 5]);
  for (const bad of [null, undefined, [], [1], [0, 3], [3, 1], [1.5, 2], ['1', '2'], [1, 2, 3], [-1, 4], [1, 1e9], 'x', {}]) assert.equal(lineRange(bad), null, JSON.stringify(bad));
});

test('prepareWebviewHtml: nonce on every script, resources through the webview scheme, and a strict policy', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="viewer.css"><script>document.documentElement.className="js"</script></head><body><script type="application/json" id="d">{}</script><script src="viewer.js"></script><script src="https://evil.example/x.js"></script></body></html>';
  const out = prepareWebviewHtml(html, { cspSource: 'vscode-webview://abc', nonce: 'N0NCE', asUri: (f) => `vscode-webview://abc/${f}` });
  assert.equal((out.match(/<script nonce="N0NCE"/g) || []).length, 4, 'every script tag, inline or not');
  assert.match(out, /href="vscode-webview:\/\/abc\/viewer\.css"/);
  assert.match(out, /src="vscode-webview:\/\/abc\/viewer\.js"/);
  assert.match(out, /src="https:\/\/evil\.example\/x\.js"/, 'remote URLs are left alone (and the policy blocks them)');
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(out)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N0NCE'/);
  assert.ok(!/script-src[^;]*(unsafe-inline|unsafe-eval|https?:)/.test(csp), 'no inline or remote code');
  assert.ok(!/connect-src|frame-src|object-src/.test(csp) || /default-src 'none'/.test(csp), 'nothing can talk to the network');
  assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<link'), 'the policy comes first in <head>');
  assert.equal(prepareWebviewHtml('<body>x</body>', { cspSource: 'c', nonce: 'n', asUri: (f) => f }).startsWith('<meta http-equiv="Content-Security-Policy"'), true, 'a page without <head> still gets one');
});

test('randomNonce: long, hex and different every time', () => {
  const a = randomNonce(), b = randomNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('extension manifest: two commands, no activation on startup, no network permissions, MIT and pointing at the repository', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../vscode-extension/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.contributes.commands.map((c) => c.command), ['gitvisualise.openTour', 'gitvisualise.refreshTour']);
  assert.deepEqual(pkg.activationEvents, [], 'VS Code activates it when a contributed command runs');
  assert.equal(pkg.license, 'MIT');
  assert.ok(!pkg.dependencies, 'zero runtime dependencies, like the rest of the project');
  assert.match(pkg.repository.url, /Kaushik2210\/gitVisualise/);
});

test('extension: the desktop-only VS Code runner is not something `node --test` discovers by default', () => {
  // node's default globs include *-test.mjs, *.test.mjs, test-*.mjs and anything under a test/ folder: the runner that opens a real VS Code must match none.
  const runner = 'vscode-extension/scripts/run-in-vscode.mjs';
  assert.ok(fs.existsSync(new URL('../' + runner, import.meta.url)));
  assert.ok(!/(-test|_test|\.test)\.m?js$|(^|\/)test-[^/]*\.m?js$|(^|\/)test\/|(^|\/)test\.m?js$/.test(runner), runner);
  assert.ok(!/(-test|_test|\.test)\.m?js$|(^|\/)test-[^/]*\.m?js$|(^|\/)test\//.test('vscode-extension/e2e/suite.js'));
});
