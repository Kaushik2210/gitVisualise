// Everything the Marketplace and Open VSX publishing needs, checked without a token or a network: a valid icon, complete package
// metadata, a .vscodeignore that keeps tests and scripts out of the package, and a workflow that cannot leak or require a secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = (f) => path.join(root, 'vscode-extension', f);
const pkg = JSON.parse(fs.readFileSync(ext('package.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(root, '.github/workflows/vscode-extension.yml'), 'utf8');

test('extension: the icon is a real PNG of at least 128x128 that package.json points at', () => {
  assert.equal(pkg.icon, 'icon.png');
  const png = fs.readFileSync(ext(pkg.icon));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  assert.ok(png.readUInt32BE(16) >= 128 && png.readUInt32BE(20) >= 128, 'at least 128x128');
  assert.ok(png.length < 1024 * 1024);
});

test('extension: Marketplace metadata is complete, and the new command is wired into the palette, menu and keys', () => {
  for (const k of ['name', 'displayName', 'description', 'version', 'publisher', 'license', 'repository', 'homepage', 'bugs', 'categories', 'keywords', 'galleryBanner']) assert.ok(pkg[k], k);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.description.length >= 60 && pkg.description.length <= 300);
  assert.ok(fs.existsSync(ext('LICENSE')) && fs.existsSync(ext('README.md')));
  const cmds = pkg.contributes.commands.map((c) => c.command);
  assert.ok(cmds.includes('gitvisualise.whereAmI'));
  assert.ok(pkg.contributes.menus['editor/context'].some((m) => m.command === 'gitvisualise.whereAmI'));
  assert.ok(pkg.contributes.keybindings.some((k) => k.command === 'gitvisualise.whereAmI'));
  assert.match(fs.readFileSync(ext('extension.js'), 'utf8'), /registerCommand\('gitvisualise\.whereAmI'/);
});

test('extension: .vscodeignore keeps tests, scripts and dev files out of the package', () => {
  const ignore = fs.readFileSync(ext('.vscodeignore'), 'utf8');
  for (const must of ['e2e/**', 'scripts/**', '.vscode/**', '**/*.vsix']) assert.ok(ignore.split('\n').includes(must), must);
  assert.ok(!/^skill\//m.test(ignore), 'the bundled engine must ship');
});

test('publish workflow: builds a .vsix on pull requests, ships it on a version tag, and only ever reads tokens from secrets', () => {
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /tags: \['vscode-v\*'\]/);
  assert.match(workflow, /vsce package/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /vscode-v\$\{version\}/, 'the tag must match the package version');
  // both tokens are optional and come only from secrets; nothing token-shaped is written into the file
  assert.match(workflow, /VSCE_PAT: \$\{\{ secrets\.VSCE_PAT \}\}/);
  assert.match(workflow, /OVSX_PAT: \$\{\{ secrets\.OVSX_PAT \}\}/);
  assert.match(workflow, /if: \$\{\{ env\.VSCE_PAT != '' \}\}/);
  assert.match(workflow, /if: \$\{\{ env\.OVSX_PAT != '' \}\}/);
  assert.match(workflow, /vsce publish --packagePath/);
  assert.match(workflow, /ovsx publish/);
  assert.ok(!/(ghp_|github_pat_|[A-Za-z0-9]{52})/.test(workflow), 'no token-like string');
  assert.ok(!/echo[^\n]*\$\{?(VSCE|OVSX)_PAT/.test(workflow), 'the tokens are never echoed');
  assert.match(workflow, /permissions:\n  contents: read/, 'read-only by default; only the release job may write');
});

test('extension README documents publishing, naming the secrets but not holding any value', () => {
  const readme = fs.readFileSync(ext('README.md'), 'utf8');
  assert.match(readme, /VSCE_PAT/);
  assert.match(readme, /OVSX_PAT/);
  assert.match(readme, /Show this file in the architecture tour/);
  assert.ok(!/(ghp_|github_pat_)/.test(readme));
});
