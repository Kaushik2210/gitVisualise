// The tour inside a VS Code webview: the page the extension builds (strict Content-Security-Policy, script nonces, resources
// rewritten to webview URIs) must still run, and "Open in editor" must message the host with the right file and line.
// A stand-in acquireVsCodeApi plays the host, so this runs in plain headless Chrome. Run with `npm run e2e`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchPage, findChrome } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { prepareWebviewHtml } = createRequire(import.meta.url)('../vscode-extension/lib.js');
const required = process.env.GV_REQUIRE_CHROME === '1';
const skip = !required && (!findChrome() || typeof WebSocket === 'undefined') ? 'needs Chrome and Node 22+' : false;

test('vscode webview: the tour runs under the extension\'s CSP and asks the host to open a file at a line', { skip, timeout: 90000 }, async () => {
  // a small repository and its tour, built exactly as the extension builds it
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-wv-repo-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"demo","main":"src/main.js"}');
  fs.writeFileSync(path.join(repo, 'src/main.js'), "import { a } from './a.js';\nimport { b } from './b.js';\nconsole.log(a, b);\n");
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'src/b.js'), "import { a } from './a.js';\nexport const b = a + 1;\n");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-wv-out-'));
  execFileSync('node', [path.join(here, '../skills/repo-architecture/scripts/gitvisualise.mjs'), 'all', repo, '--out', out, '--no-pin'], { stdio: 'pipe' });

  const html = prepareWebviewHtml(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), {
    cspSource: 'file:', nonce: 'testnonce123', asUri: (f) => pathToFileURL(path.join(out, f)).href,
  });
  assert.match(html, /Content-Security-Policy/);
  assert.ok(!/<script(?![^>]*nonce=)/i.test(html), 'every script carries the nonce');
  fs.writeFileSync(path.join(out, 'webview.html'), html);

  const { page, close } = await launchPage();
  try {
    // the host: acquireVsCodeApi exists only inside a webview; record what the page posts, and any CSP violation
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__posted = []; window.__violations = [];
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => null, setState: () => {} });
      document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));
    ` });
    await page.send('Page.navigate', { url: pathToFileURL(path.join(out, 'webview.html')).href });
    const nodes = await page.waitFor(async () => { const n = await page.eval("document.querySelectorAll('#diagram .node').length"); return n >= 3 ? n : 0; }, 'the diagram under the CSP');
    assert.ok(nodes >= 3);

    // select a component: its source block offers "Open in editor" (only inside a webview), and clicking it messages the host
    await page.eval("document.querySelector('#diagram .node').dispatchEvent(new MouseEvent('click', { bubbles: true })); 1");
    const label = await page.waitFor(() => page.eval("[...document.querySelectorAll('#detail-body button')].map((b) => b.textContent).find((t) => t === 'Open in editor') || ''"), 'an Open in editor button');
    assert.equal(label, 'Open in editor');
    await page.eval("[...document.querySelectorAll('#detail-body button')].find((b) => b.textContent === 'Open in editor').click(); 1");
    const posted = await page.eval('window.__posted');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'open');
    assert.match(posted[0].path, /^(src\/|package\.json)/, 'a repository-relative path: ' + posted[0].path);
    assert.ok(posted[0].lines === null || (Array.isArray(posted[0].lines) && posted[0].lines[0] >= 1));

    // playing the tour needs no forbidden capability either
    await page.eval("document.getElementById('btn-next').click(); 1");
    await page.waitFor(() => page.eval("document.querySelectorAll('#diagram .node.active').length > 0"), 'an active component');
    assert.deepEqual(await page.eval('window.__violations'), [], 'the Content-Security-Policy blocked nothing the tour needs');
  } finally {
    await close();
    for (const d of [repo, out]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a lock on Windows */ } }
  }
});
