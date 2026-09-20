// Browser smoke test for the website: loads docs/ in headless Chrome with a fake GitHub, analyses a repository, and checks
// that the tour is really on screen. It exists because of a bug unit tests cannot see: in 1.0.0 the results view showed only a
// toolbar and a blank frame. Run with `npm run e2e` (Node 22+, Chrome or Chromium installed). CI runs it in its own job.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, findChrome } from './cdp.mjs';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');
const required = process.env.GV_REQUIRE_CHROME === '1';
const skip = !required && (!findChrome() || typeof WebSocket === 'undefined') ? 'needs Chrome and Node 22+ (set GV_REQUIRE_CHROME=1 to make this a failure)' : false;

const SHA = 'c'.repeat(40);
const FILES = {
  'package.json': JSON.stringify({ name: 'demo', description: 'A demo service', main: 'src/server.js', dependencies: { express: '^4.0.0' } }),
  'src/server.js': "import express from 'express';\nimport { listUsers } from './services/users.js';\nconst app = express();\napp.get('/users', (req, res) => res.json(listUsers()));\napp.listen(3000);\n",
  'src/services/users.js': "import { db } from '../db/store.js';\nexport function listUsers() { return db.users; }\n",
  'src/db/store.js': 'export const db = { users: [] };\n',
  'src/web/client.js': "import axios from 'axios';\nexport const users = () => axios.get('/users');\n",
};

/** Replaces fetch for the two GitHub hosts (the page is served from localhost, so nothing can reach the real one). */
const fakeGithub = `(() => {
  const FILES = ${JSON.stringify(FILES)}, SHA = '${SHA}', real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    const ok = (body, headers) => new Response(body, { status: 200, headers });
    if (u.hostname === 'api.github.com') {
      if (!u.pathname.startsWith('/repos/o/r/')) return new Response('{"message":"Not Found"}', { status: 404 });
      if (/\\/commits\\//.test(u.pathname)) return ok(SHA, { 'x-ratelimit-remaining': '55' });
      if (/\\/git\\/trees\\//.test(u.pathname)) return ok(JSON.stringify({ sha: SHA, truncated: false, tree: Object.keys(FILES).map((p) => ({ path: p, type: 'blob', size: FILES[p].length })) }));
      return new Response('{}', { status: 404 });
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      const p = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
      return FILES[p] != null ? ok(FILES[p]) : new Response('', { status: 404 });
    }
    return real(input, init);
  };
})();`;

function serve(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(dir, path.normalize(p));
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

test('website: a pasted repository becomes a visible, working tour', { skip, timeout: 120000 }, async () => {
  assert.ok(fs.existsSync(path.join(DOCS, 'index.html')), 'docs/ is built (run npm run site)');
  const { server, url } = await serve(DOCS);
  const { page, close } = await launchPage();
  const problems = [];
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/Failed to load resource/.test(m.params.entry.text)) problems.push('console: ' + m.params.entry.text);
  });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeGithub });
    const inTour = (expr) => page.evalFrame(expr);

    // 1. the landing page renders
    await page.send('Page.navigate', { url });
    await page.waitFor(() => page.eval("document.readyState === 'complete' && !!document.getElementById('repo')"), 'the landing page');
    assert.match(await page.eval('document.title'), /gitvisualise/i);
    assert.ok((await page.eval("document.querySelectorAll('.gcard').length")) >= 4, 'the gallery is there');

    // 2. paste a repository: the results view opens, and the tour frame is really populated
    await page.eval("document.getElementById('repo').value = 'o/r'; document.getElementById('go').requestSubmit(); 1");
    await page.waitFor(() => page.eval("!document.getElementById('result').hidden"), 'the results view');
    assert.equal(await page.eval("document.getElementById('r-title').textContent"), 'o/r');
    const box = await page.waitFor(async () => {
      const b = await page.eval("(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()");
      return b.w > 600 && b.h > 300 ? b : null;
    }, 'a frame with a real size');
    assert.ok(box.w > 600 && box.h > 300, 'the frame is not collapsed: ' + JSON.stringify(box));
    const nodes = await page.waitFor(async () => { const n = await inTour("document.querySelectorAll('#diagram .node').length"); return n >= 3 ? n : 0; }, 'diagram nodes inside the tour frame');
    assert.ok(nodes >= 3, `the diagram has components (${nodes})`);
    assert.ok(page.seenTargets.has('worker'), 'the analysis ran in a Web Worker (targets seen: ' + [...page.seenTargets] + ')');
    assert.ok((await inTour("document.querySelectorAll('#diagram .edge').length")) >= 2, 'and connections');
    assert.match(await inTour("document.getElementById('step-title').textContent"), /\S/, 'and a heading');
    const shots = process.env.GV_E2E_SHOTS;
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot(path.join(shots, 'tour.png')); }

    // 3. playing works: next step highlights something
    await inTour("document.getElementById('btn-next').click(); 1");
    await page.waitFor(() => inTour("document.querySelectorAll('#diagram .node.active').length > 0"), 'an active component after Next');
    assert.match(await inTour("document.getElementById('step-count').textContent"), /Step 1/);

    // 4. the Export menu opens and Copy as Mermaid answers (copied, or saved when the clipboard is blocked)
    await page.eval("document.querySelector('#export-menu summary').click(); 1");
    assert.equal(await page.eval("document.getElementById('export-menu').open"), true);
    await page.eval("document.getElementById('cp-mermaid').click(); 1");
    await page.waitFor(() => page.eval("/Mermaid copied|Clipboard is blocked/.test(document.getElementById('toast').textContent)"), 'the Mermaid toast');

    // 5. a deep link opens the tour at that step
    await page.send('Page.navigate', { url: url + '#/o/r/flow/startup/step/2' });
    await page.eval('location.reload(); 1');
    await page.waitFor(() => page.eval("!document.getElementById('result').hidden"), 'the results view again');
    await page.waitFor(async () => /Step 2/.test(await inTour("document.getElementById('step-count').textContent")), 'step 2 from the link');

    // 6. an unknown repository shows a readable error, not a blank page
    await page.send('Page.navigate', { url: url + '#/o/missing' }); // a hash change: the app routes to it by itself
    await page.waitFor(() => page.eval("!document.getElementById('err').hidden"), 'the error message');
    assert.match(await page.eval("document.getElementById('err').textContent"), /not found|private|misspelled/i);

    assert.deepEqual(problems, [], 'no script errors or console errors');
  } finally {
    await close();
    server.close();
  }
});
