// The "?" shortcuts dialog (viewer.js: KEYBOARD_SHORTCUTS) must list the real shortcuts, not a stale
// hand-written copy. This extracts the literal keys the actual handlers check and the keys the dialog
// lists, then compares them, so a shortcut added to one and forgotten in the other fails the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = fs.readFileSync(new URL('../skills/repo-architecture/viewer/viewer.js', import.meta.url), 'utf8');

// Display form used in the dialog for each raw KeyboardEvent.key value the code actually checks.
const DISPLAY = { ' ': 'Space', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', r: 'R', R: 'R', Escape: 'Esc', '/': '/', '?': '?', Enter: 'Enter' };

function block(src, startRe, open = '{', close = '}') {
  const start = src.search(startRe);
  assert.notEqual(start, -1, `could not find ${startRe} in viewer.js`);
  let depth = 0, i = src.indexOf(open, start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(from, i + 1);
  }
  throw new Error(`unbalanced ${open}${close}`);
}

test('shortcuts dialog: every key the global handler checks is listed', () => {
  const handler = block(js, /document\.addEventListener\('keydown'/);
  const raw = [...handler.matchAll(/e\.key === '([^']*)'/g)].map((m) => m[1]);
  assert.ok(raw.length >= 6, 'expected several key checks in the global keydown handler');
  const dialogSrc = block(js, /var KEYBOARD_SHORTCUTS = \[/, '[', ']');
  for (const key of raw) {
    const display = DISPLAY[key];
    assert.ok(display, `no display form registered for key ${JSON.stringify(key)} — add one to DISPLAY in this test`);
    assert.ok(dialogSrc.includes(`'${display}'`), `key ${JSON.stringify(key)} (shown as ${display}) is checked by the handler but missing from KEYBOARD_SHORTCUTS`);
  }
});

test('shortcuts dialog: component-to-component arrow navigation (neighbourFor) is listed', () => {
  const dirs = block(js, /var dirs = \{/);
  const raw = [...dirs.matchAll(/(ArrowRight|ArrowLeft|ArrowUp|ArrowDown):/g)].map((m) => m[1]);
  assert.equal(raw.length, 4, 'expected all four arrow directions in neighbourFor');
  const dialogSrc = block(js, /var KEYBOARD_SHORTCUTS = \[/, '[', ']');
  for (const key of raw) assert.ok(dialogSrc.includes(`'${DISPLAY[key]}'`), `${key} missing from KEYBOARD_SHORTCUTS`);
});

test('shortcuts dialog: opens on "?", is a real <dialog>, and restores focus on close', () => {
  assert.match(js, /e\.key === '\?'.*openShortcuts\(\)/);
  assert.match(js, /shortcutsDlg\.showModal\(\)/);
  assert.match(js, /shortcutsOpener\.focus\(\)/);
  const html = fs.readFileSync(new URL('../skills/repo-architecture/viewer/index.template.html', import.meta.url), 'utf8');
  assert.match(html, /<dialog id="shortcuts-dialog"/);
  assert.match(html, /id="keys-btn"[^>]*aria-haspopup="dialog"/);
});
