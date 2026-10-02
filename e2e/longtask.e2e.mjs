// Main-thread responsiveness while a large repository is analysed (#51): the website loads a fake GitHub whose file tree has as many
// entries as facebook/react (7,245), and a `longtask` observer must not see a task over 100 ms between pressing "Go" and the results
// view. The CPU is throttled (4x by default, GV_CPU_THROTTLE) so a laptop-class machine stands in for a slow one. GV_DOCS points at another build of the website
// (to compare with an older one); GV_LONGTASK_BUDGET overrides the 100 ms limit. Run with `npm run e2e`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, findChrome } from './cdp.mjs';
import { bigTree, fakeGithub, serve } from './big-repo.mjs';

const DOCS = process.env.GV_DOCS ? path.resolve(process.env.GV_DOCS) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');
const BUDGET = Number(process.env.GV_LONGTASK_BUDGET || 100);
const THROTTLE = Number(process.env.GV_CPU_THROTTLE || 4);
const required = process.env.GV_REQUIRE_CHROME === '1';
const skip = !required && (!findChrome() || typeof WebSocket === 'undefined') ? 'needs Chrome and Node 22+ (set GV_REQUIRE_CHROME=1 to make this a failure)' : false;

test('website: analysing a 7,245-file repository never blocks the page for more than 100 ms', { skip, timeout: 180000 }, async () => {
  assert.ok(fs.existsSync(path.join(DOCS, 'index.html')), 'the website is built (run npm run site)');
  const { server, url } = await serve(DOCS);
  const { page, close } = await launchPage();
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__long = [];
      try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true }); } catch (e) { window.__noLongTask = true; }
    ` });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeGithub(bigTree(7245)) });
    await page.send('Page.navigate', { url });
    await page.waitFor(() => page.eval("document.readyState === 'complete' && !!document.getElementById('repo')"), 'the landing page');
    assert.equal(await page.eval('!!window.__noLongTask'), false, 'this browser reports long tasks');
    await page.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await new Promise((r) => setTimeout(r, 500)); // let page start-up work finish so it is not counted
    const t0 = await page.eval('Math.round(performance.now())');
    await page.eval("document.getElementById('repo').value = 'o/r'; document.getElementById('go').requestSubmit(); 1");
    await page.waitFor(() => page.eval("!document.getElementById('result').hidden"), 'the results view', 120000);
    const t1 = await page.eval('Math.round(performance.now())');
    const during = (await page.eval('window.__long')).filter(([start]) => start >= t0 && start <= t1);
    const worst = during.reduce((m, [, d]) => Math.max(m, d), 0);
    console.log(`# analysis took ${t1 - t0} ms (${THROTTLE}x CPU throttle); ${during.length} long task(s), worst ${worst} ms ${JSON.stringify(during)}`);
    assert.ok(page.seenTargets.has('worker'), 'the analysis ran in a Web Worker');
    assert.ok(worst <= BUDGET, `a ${worst} ms task blocked the page during analysis (budget ${BUDGET} ms): ${JSON.stringify(during)}`);
  } finally {
    await close();
    server.close();
  }
});
