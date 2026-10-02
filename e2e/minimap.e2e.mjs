// The viewer's minimap in headless Chrome: hidden while the whole diagram fits, shown (decoratively, with no tab stop) once the camera
// is zoomed in, it follows zoom, "Zoom to step" and collapsed lanes, and clicking or dragging it moves the camera. Run with `npm run e2e`.
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

test('viewer minimap: hidden when everything fits, follows the camera, and moves it on click and drag', { skip, timeout: 90000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-mm-repo-'));
  fs.mkdirSync(path.join(repo, 'src/lib'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src/ui'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"demo","main":"src/main.js"}');
  const mods = [];
  for (let i = 0; i < 14; i++) {
    const dir = i % 2 ? 'src/lib' : 'src/ui';
    mods.push(`${dir}/m${i}.js`);
    fs.writeFileSync(path.join(repo, dir, `m${i}.js`), `${i ? `import { v${i - 1} } from '../${mods[i - 1].replace(/^src\//, '')}';\n` : ''}export const v${i} = ${i};\n`);
  }
  fs.writeFileSync(path.join(repo, 'src/main.js'), mods.map((m, i) => `import { v${i} } from './${m.replace(/^src\//, '')}';`).join('\n') + '\nconsole.log(v0);\n');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-mm-out-'));
  execFileSync('node', [path.join(here, '../skills/repo-architecture/scripts/gitvisualise.mjs'), 'all', repo, '--out', out, '--no-pin'], { stdio: 'pipe' });

  const { page, close } = await launchPage();
  try {
    await page.send('Page.navigate', { url: pathToFileURL(path.join(out, 'index.html')).href });
    await page.waitFor(async () => (await page.eval("document.querySelectorAll('#diagram .node').length")) >= 10, 'the diagram');
    const view = () => page.eval("document.getElementById('diagram').getAttribute('viewBox').split(' ').map(Number)");
    const mmHidden = () => page.eval("document.getElementById('minimap').hidden");

    // everything fits after the initial fit: nothing to navigate, so no minimap
    assert.equal(await mmHidden(), true);

    // zoom in: the map appears, decorative, with no tab stops, and the viewport rectangle is smaller than the whole diagram
    await page.eval("document.getElementById('zoom-in').click(); document.getElementById('zoom-in').click(); document.getElementById('zoom-in').click(); 1");
    assert.equal(await mmHidden(), false);
    assert.equal(await page.eval("document.getElementById('minimap').getAttribute('aria-hidden')"), 'true');
    assert.equal(await page.eval("document.querySelectorAll('#minimap [tabindex], #minimap a, #minimap button, #minimap input').length"), 0);
    assert.ok((await page.eval("document.querySelectorAll('#minimap .mm-node').length")) >= 10, 'one rectangle per component');
    const rect = () => page.eval("(() => { const r = document.querySelector('#minimap .mm-view'); return ['x','y','width','height'].map((k) => Number(r.getAttribute(k))); })()");
    const [vx, vy, vw, vh] = await view();
    assert.deepEqual(await rect(), [vx, vy, vw, vh], 'the rectangle is the camera');

    // clicking the map centres the camera on that spot
    const box = await page.eval("(() => { const r = document.getElementById('minimap').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()");
    const click = async (x, y) => {
      await page.eval(`(() => { const m = document.getElementById('minimap'); const o = { bubbles: true, clientX: ${x}, clientY: ${y}, pointerId: 1 };
        m.setPointerCapture = () => {}; m.dispatchEvent(new PointerEvent('pointerdown', o)); m.dispatchEvent(new PointerEvent('pointerup', o)); })()`);
    };
    await click(box[0] + 8, box[1] + 8);
    const [x1, y1] = await view();
    await click(box[0] + box[2] - 8, box[1] + box[3] - 8);
    const [x2, y2] = await view();
    assert.ok(x2 > x1 && y2 >= y1, `clicking the far corner moves right/down: ${x1},${y1} -> ${x2},${y2}`);
    assert.deepEqual(await rect(), [x2, y2, vw, vh].map((n, i) => (i < 2 ? n : n)), 'the rectangle follows');

    // dragging keeps moving it
    await page.eval(`(() => { const m = document.getElementById('minimap'); m.setPointerCapture = () => {};
      m.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${box[0] + box[2] - 8}, clientY: ${box[1] + 8}, pointerId: 1 }));
      m.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${box[0] + 8}, clientY: ${box[1] + 8}, pointerId: 1 }));
      m.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); })()`);
    const [x3] = await view();
    assert.ok(x3 < x2, 'dragging left moves the camera left');

    // fit again: hidden
    await page.eval("document.getElementById('zoom-fit').click(); 1");
    assert.equal(await mmHidden(), true);

    // "Zoom to step" moves the camera; whatever it shows, the map agrees with it (hidden only when the whole diagram is in view)
    await page.eval("(() => { const f = document.getElementById('follow'); if (!f.checked) f.click(); document.getElementById('btn-next').click(); document.getElementById('btn-next').click(); })()");
    await page.waitFor(async () => (await page.eval("document.querySelectorAll('#diagram .node.active').length")) > 0, 'an active step');
    const [sx, sy, sw, sh] = await view();
    const bounds = await page.eval("(() => { const b = [...document.querySelectorAll('#minimap .mm-node')].map((r) => ['x','y','width','height'].map((k) => Number(r.getAttribute(k)))); return [Math.min(...b.map((r) => r[0])), Math.min(...b.map((r) => r[1])), Math.max(...b.map((r) => r[0] + r[2])), Math.max(...b.map((r) => r[1] + r[3]))]; })()");
    const everything = sx <= bounds[0] + 2 && sy <= bounds[1] + 2 && sx + sw >= bounds[2] - 2 && sy + sh >= bounds[3] - 2;
    assert.equal(await mmHidden(), everything);
    if (!everything) assert.deepEqual(await rect(), [sx, sy, sw, sh]);

    // hidden on a phone-sized screen
    await page.send('Emulation.setDeviceMetricsOverride', { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.eval("getComputedStyle(document.getElementById('minimap')).display"), 'none');
  } finally {
    await close();
  }
});
