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
