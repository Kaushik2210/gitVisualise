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
    if (u.hostname === 'api.anthropic.com') {
      (window.__aiCalls = window.__aiCalls || []).push({ url: String(u), key: init && init.headers && init.headers['x-api-key'], body: init && init.body });
      if (init.headers['x-api-key'] === 'bad-key-value') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'This step shows how the main pieces of the project fit together.' }] }), { status: 200 });
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

    // 3b. swimlanes: group by kind, fold a lane into a chip and unfold everything again
    await inTour("(() => { const g = document.getElementById('group-by'); g.value = 'kind'; g.dispatchEvent(new Event('change')); return 1; })()");
    const lanes = await page.waitFor(() => inTour("document.querySelectorAll('#diagram .lane-head').length"), 'swimlanes');
    assert.ok(lanes >= 2, 'the kinds become lanes');
    await inTour("document.querySelector('#diagram .lane-head').dispatchEvent(new MouseEvent('click', { bubbles: true })); 1");
    await page.waitFor(() => inTour("document.querySelectorAll('#diagram .lane-chip').length === 1"), 'a chip for the collapsed lane');
    assert.ok((await inTour("document.querySelectorAll('#diagram .node.lane-hidden').length")) >= 1, 'its components are folded away');
    await inTour("document.getElementById('lanes-toggle').click(); 1"); // collapse the rest
    await page.waitFor(() => inTour("document.querySelectorAll('#diagram .lane-chip').length === document.querySelectorAll('#diagram .lane-head').length"), 'every lane folded');
    await inTour("document.getElementById('lanes-toggle').click(); 1"); // and expand all
    await page.waitFor(() => inTour("document.querySelectorAll('#diagram .lane-chip').length === 0"), 'every lane unfolded');

    // 4. the Export menu opens and Copy as Mermaid answers (copied, or saved when the clipboard is blocked)
    await page.eval("document.querySelector('#export-menu summary').click(); 1");
    assert.equal(await page.eval("document.getElementById('export-menu').open"), true);
    await page.eval("document.getElementById('cp-mermaid').click(); 1");
    await page.waitFor(() => page.eval("/Mermaid copied|Clipboard is blocked/.test(document.getElementById('toast').textContent)"), 'the Mermaid toast');

    // 4b. optional AI narration: nothing is sent until the visitor confirms, the key is only ever a header, and the result is labelled
    await page.eval("document.querySelector('#export-menu summary').click(); document.getElementById('ai-open').click(); 1");
    await page.waitFor(() => page.eval("document.getElementById('ai-dialog').open"), 'the AI dialog');
    assert.equal(await page.eval("document.getElementById('ai-start').disabled"), true, 'Start is disabled until a key and the confirmation are given');
    const preview = await page.eval("document.getElementById('ai-preview').textContent");
    assert.match(preview, /"components"/);
    for (const code of ['res.json(listUsers())', 'return db.users', 'app.listen(3000)', 'export const db']) assert.ok(!preview.includes(code), 'the preview shows facts, not source code: ' + code);
    await page.eval("(() => { const k = document.getElementById('ai-key'); k.value = 'sk-ant-e2e-secret-key'; k.dispatchEvent(new Event('input', { bubbles: true })); })()");
    assert.equal(await page.eval("document.getElementById('ai-start').disabled"), true, 'a key alone is not enough');
    await page.eval("(() => { const c = document.getElementById('ai-confirm'); c.checked = true; c.dispatchEvent(new Event('input', { bubbles: true })); })()");
    assert.equal(await page.eval("document.getElementById('ai-start').disabled"), false);
    assert.equal(await page.eval("(window.__aiCalls || []).length"), 0, 'nothing was sent before Start');
    await page.eval("document.getElementById('ai-start').click(); 1");
    await page.waitFor(() => page.eval("!document.getElementById('ai-dialog').open"), 'the dialog to close after narrating');
    const calls = await page.eval('window.__aiCalls');
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((c) => c.url === 'https://api.anthropic.com/v1/messages' && c.key === 'sk-ant-e2e-secret-key' && !c.body.includes('sk-ant-e2e-secret-key')), 'the key goes only in a header, to the provider');
    for (const c of calls) for (const code of ['res.json(listUsers())', 'return db.users', 'app.listen(3000)', 'export const db']) assert.ok(!c.body.includes(code), 'no source code was sent: ' + code);
    assert.equal(await page.eval("document.getElementById('ai-key').value"), '', 'the key is cleared afterwards');
    await page.waitFor(() => page.eval("/narrated by AI/.test(document.getElementById('toast').textContent)"), 'the result toast');
    // the tour was rebuilt: a step now carries the label and the model's text
    await page.waitFor(async () => (await inTour("document.getElementById('step-count') && document.getElementById('step-count').textContent")) === 'Overview', 'the rebuilt tour');
    await inTour("document.getElementById('btn-next').click(); 1");
    await page.waitFor(() => inTour("!document.getElementById('ai-tag').hidden"), 'the AI-written label');
    assert.match(await inTour("document.getElementById('step-text').textContent"), /fit together/);

    // a rejected key changes nothing and says so
    await page.eval("document.querySelector('#export-menu summary').click(); document.getElementById('ai-open').click(); 1");
    await page.waitFor(() => page.eval("document.getElementById('ai-dialog').open"), 'the dialog again');
    await page.eval("(() => { const k = document.getElementById('ai-key'); k.value = 'bad-key-value'; k.dispatchEvent(new Event('input', { bubbles: true })); const c = document.getElementById('ai-confirm'); c.checked = true; c.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('ai-start').click(); })()");
    await page.waitFor(() => page.eval("/rejected that API key/.test(document.getElementById('ai-status').textContent)"), 'the key rejection message');
    await page.eval("document.getElementById('ai-cancel').click(); 1");

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
