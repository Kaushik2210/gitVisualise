// The "Loops" toggle in a real browser: hidden when the tour has no circular dependency, and when it has one it outlines exactly the
// components and imports of the loop, marks them without relying on colour, and remembers the choice. Run with `npm run e2e`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchPage, findChrome } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const required = process.env.GV_REQUIRE_CHROME === '1';
const skip = !required && (!findChrome() || typeof WebSocket === 'undefined') ? 'needs Chrome and Node 22+' : false;
const CLI = path.join(here, '../skills/repo-architecture/scripts/gitvisualise.mjs');

function tour(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-loops-repo-'));
  for (const [rel, txt] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), txt); }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-loops-out-'));
  execFileSync('node', [CLI, 'all', repo, '--out', out, '--no-pin'], { stdio: 'pipe' });
  return { repo, out };
}

test('loops toggle: hidden without a loop; with one it outlines the loop, marks it without colour, and is remembered', { skip, timeout: 120000 }, async () => {
  const looped = tour({
    'package.json': '{"name":"demo","main":"src/index.js"}',
    'src/index.js': "import { a } from './a.js';\nimport { c } from './c.js';\nconsole.log(a, c);\n",
    'src/a.js': "import { b } from './b.js';\nexport const a = () => b();\n",
    'src/b.js': "import { a } from './a.js';\nexport const b = () => a();\n",
    'src/c.js': 'export const c = 1;\n',
  });
  const flat = tour({
    'package.json': '{"name":"demo","main":"src/index.js"}',
    'src/index.js': "import { a } from './a.js';\nconsole.log(a);\n",
    'src/a.js': 'export const a = 1;\n',
  });
  const { page, close } = await launchPage();
  try {
    const open = async (dir) => {
      await page.send('Page.navigate', { url: pathToFileURL(path.join(dir, 'index.html')).href });
      await page.waitFor(() => page.eval("document.querySelectorAll('#diagram .node').length >= 2"), 'the diagram');
    };

    await open(flat.out);
    assert.equal(await page.eval("document.getElementById('loops-btn').hidden"), true, 'no loop, no button');

    await open(looped.out);
    assert.equal(await page.eval("document.getElementById('loops-btn').hidden"), false);
    assert.equal(await page.eval("document.querySelectorAll('#diagram .in-loop').length"), 0, 'off by default');
    assert.equal(await page.eval("document.getElementById('loops-btn').getAttribute('aria-pressed')"), 'false');

    await page.eval("document.getElementById('loops-btn').click(); 1");
    assert.equal(await page.eval("document.getElementById('loops-btn').getAttribute('aria-pressed')"), 'true');
    const nodes = await page.eval("[...document.querySelectorAll('#diagram .node.in-loop')].map((n) => n.getAttribute('data-id')).sort()");
    assert.deepEqual(nodes, ['a-js', 'b-js'], 'exactly the two components in the loop, not index or c');
    const edges = await page.eval("document.querySelectorAll('#diagram .edge.in-loop').length");
    assert.equal(edges, 2, 'both imports of the loop');
    const marks = await page.eval("[...document.querySelectorAll('#diagram .node.in-loop text.sub')].map((t) => t.textContent.charAt(0))");
    assert.deepEqual(marks, ['↻', '↻'], 'a mark in the label, so the loop is readable without colour');
    const dash = await page.eval("getComputedStyle(document.querySelector('#diagram .node.in-loop rect.box')).strokeDasharray");
    assert.match(dash, /10/, 'a dash pattern on the outline: ' + dash);

    // remembered across a reload
    await page.send('Page.reload');
    await page.waitFor(() => page.eval("document.querySelectorAll('#diagram .node.in-loop').length === 2"), 'the loop still highlighted after reload');

    // and it exports: the SVG export inlines the computed style, so the outline travels with it
    const svg = await page.eval('window.__gvExportSvg().text');
    assert.match(svg, /stroke-dasharray:\s*10/, 'the exported SVG carries the loop outline');

    await page.eval("document.getElementById('loops-btn').click(); 1");
    assert.equal(await page.eval("document.querySelectorAll('#diagram .in-loop').length"), 0, 'toggles back off');
  } finally {
    await close();
    for (const d of [looped.repo, looped.out, flat.repo, flat.out]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a lock on Windows */ } }
  }
});
