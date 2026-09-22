// Accessibility guards for the viewer: semantics that must not regress, and WCAG contrast of the colour tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const V = new URL('../skills/repo-architecture/viewer/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, V), 'utf8');
const html = read('index.template.html');
const js = read('viewer.js');
const css = read('viewer.css');

test('a11y: the diagram is a group, not an image, so its components stay reachable', () => {
  assert.match(html, /<svg id="diagram" role="group"/);
  assert.ok(!/<svg id="diagram" role="img"/.test(html), 'role="img" hides every child from assistive technology');
  assert.match(html, /id="diagram-help"/);
});

test('a11y: one polite status region announces steps, selections and search results', () => {
  assert.match(html, /id="sr-status" class="sr" role="status" aria-live="polite" aria-atomic="true"/);
  assert.ok(!/id="step-text"[^>]*aria-live/.test(html), 'the caption must not also be live, or every step is read twice');
  assert.match(js, /announce\('Step ' \+ \(S\.step \+ 1\)/);
  assert.match(js, /function announce\(/);
});

test('a11y: keyboard users get a skip link, arrow-key movement between connected components, and focus styles', () => {
  assert.match(html, /<a class="skip" href="#narration">/);
  assert.match(js, /function neighbourFor\(/);
  assert.match(css, /\.node:focus-visible rect\.box/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /\.skip:focus \{ top: 8px; \}/);
});

// ---- contrast ----
const hex = (h) => { const n = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Reads the custom properties declared in the first block matching `selector`. */
function tokens(selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}

for (const [name, sel] of [['light', ':root {'], ['dark', ':root[data-theme="dark"] {']]) {
  test(`a11y: ${name} theme colour pairs meet WCAG AA (4.5:1 for text)`, () => {
    const t = tokens(sel);
    const pairs = [['ink', 'bg'], ['ink', 'panel'], ['muted', 'panel'], ['muted', 'bg'], ['node-ink', 'node-bg'], ['accent', 'panel'], ['accent-ink', 'accent']];
    for (const [fg, bg] of pairs) {
      assert.ok(t[fg] && t[bg], `${fg}/${bg} tokens exist`);
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${name}: ${fg} ${t[fg]} on ${bg} ${t[bg]} is ${r.toFixed(2)}:1, needs 4.5:1`);
    }
  });
}

test('lanes: collapsible swimlanes are keyboard-operable buttons with state, and folded content is left out of exports', () => {
  assert.match(html, /id="lanes-toggle"/);
  assert.match(js, /'aria-expanded': lr\.collapsed \? 'false' : 'true'/);
  assert.match(js, /function toggleLane\(/);
  assert.match(js, /function expandFor\(/, 'selecting or searching a hidden component opens its lane');
  assert.match(js, /querySelectorAll\('\.lane-hidden'\)/, 'the SVG export drops hidden nodes');
  assert.match(js, /!isHidden\(other\)/, 'arrow-key navigation skips hidden components');
  assert.match(css, /\.lane-hidden \{ display: none; \}/);
  assert.match(css, /\.lane-chip\.active rect\.box/);
});

// ---- colour-blind-safe palette (#45) ----
test('palette: a toggle exists, is remembered, and drives kindColor away from the hash-of-hue default', () => {
  assert.match(html, /id="palette-btn"/);
  assert.match(js, /var SAFE_COLORS = \[/);
  assert.match(js, /var PALETTES = \['default', 'cb'\]/);
  assert.match(js, /store\('palette'\)/);
  assert.match(js, /document\.documentElement\.classList\.toggle\('cb-palette'/);
  assert.match(js, /if \(palette === 'cb'\) \{/, 'kindColor branches on the active palette');
});

test('palette: the safe palette is the real Okabe-Ito set, and every colour is a distinct hex value', () => {
  const m = /var SAFE_COLORS = \[([^\]]+)\]/.exec(js);
  assert.ok(m, 'SAFE_COLORS not found');
  const colors = [...m[1].matchAll(/#[0-9a-fA-F]{6}/g)].map((x) => x[0].toUpperCase());
  assert.ok(colors.length >= 6, 'expected a real categorical palette, not two or three colours');
  assert.equal(new Set(colors).size, colors.length, 'two kinds sharing a colour defeats the point');
});

test('palette: diff states get their own dash pattern too, not just a colour, so they read in greyscale', () => {
  assert.match(css, /\.node\.d-added rect\.box \{ stroke: var\(--d-added\); stroke-width: 3; \}/, 'added stays solid');
  assert.match(css, /\.node\.d-changed rect\.box \{[^}]*stroke-dasharray: 2 3;/, 'changed is dotted');
  assert.match(css, /\.node\.d-removed rect\.box \{[^}]*stroke-dasharray: 6 4;/, 'removed is dashed');
  assert.match(css, /\.edge\.d-changed:not\(\.active\):not\(\.selected\) path\.line \{[^}]*stroke-dasharray: 2 4;/);
  assert.match(js, /var k = h\('i', \{ class: 'diff-key d-' \+ d, text: DIFF_MARK\[d\] \}\)/, 'the legend swatch also carries the +/−/~ mark');
});

test('palette: cb-palette diff colours meet 3:1 (WCAG non-text contrast) against every panel/background token in both themes', () => {
  const cb = tokens(':root.cb-palette {');
  assert.ok(cb['d-added'] && cb['d-removed'] && cb['d-changed'], 'cb-palette overrides all three diff tokens');
  assert.equal(new Set(Object.values(cb)).size, 3, 'added/removed/changed must be three different colours');
  const light = tokens(':root {'), dark = tokens(':root[data-theme="dark"] {');
  for (const [theme, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['panel', 'bg', 'node-bg']) {
      for (const key of ['d-added', 'd-removed', 'd-changed']) {
        const r = ratio(cb[key], t[bg]);
        assert.ok(r >= 3, `${theme}: ${key} ${cb[key]} on ${bg} ${t[bg]} is ${r.toFixed(2)}:1, needs 3:1`);
      }
    }
  }
});
