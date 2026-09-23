// The website's community gallery (site/gallery.json, rendered by app.js): malformed or duplicate
// entries, or a missing screenshot, must fail here rather than break the landing page (#43).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gallerySlug, galleryImage, validateGallery } from '../skills/repo-architecture/scripts/lib/web/gallery.mjs';

test('gallerySlug/galleryImage: owner/repo becomes the underscored screenshot filename', () => {
  assert.equal(gallerySlug('tj/commander.js'), 'tj_commander_js');
  assert.equal(galleryImage('tj/commander.js', 'light'), 'assets/gallery/tj_commander_js-light.jpg');
  assert.equal(galleryImage('tj/commander.js', 'dark'), 'assets/gallery/tj_commander_js-dark.jpg');
});

test('validateGallery: accepts a well-formed, duplicate-free list', () => {
  assert.deepEqual(validateGallery([{ repo: 'tj/commander.js', lang: 'JavaScript', desc: 'A CLI framework.' }]), []);
});

test('validateGallery: rejects a malformed owner/repo', () => {
  const errors = validateGallery([{ repo: 'not-a-repo', lang: 'Go', desc: 'x' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a valid owner\/repo/);
});

test('validateGallery: rejects a duplicate repo (case-insensitively)', () => {
  const errors = validateGallery([
    { repo: 'tj/commander.js', lang: 'JavaScript', desc: 'a' },
    { repo: 'TJ/Commander.js', lang: 'JavaScript', desc: 'b' },
  ]);
  assert.ok(errors.some((e) => /duplicate/.test(e)));
});

test('validateGallery: rejects a missing lang or desc, and an over-long desc', () => {
  assert.ok(validateGallery([{ repo: 'a/b', desc: 'x' }]).some((e) => /missing "lang"/.test(e)));
  assert.ok(validateGallery([{ repo: 'a/b', lang: 'Go' }]).some((e) => /missing "desc"/.test(e)));
  assert.ok(validateGallery([{ repo: 'a/b', lang: 'Go', desc: 'x'.repeat(161) }]).some((e) => /under 160/.test(e)));
});

test('validateGallery: rejects a non-array and a non-object entry', () => {
  assert.deepEqual(validateGallery('nope'), ['gallery.json must be an array']);
  assert.ok(validateGallery([null]).some((e) => /not an object/.test(e)));
});

test('gallery.json: the real file is well-formed, and every entry has both screenshots on disk', () => {
  const gallery = JSON.parse(fs.readFileSync(new URL('../site/gallery.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateGallery(gallery), []);
  assert.ok(gallery.length >= 1, 'the gallery should not ship empty');
  const assetsDir = new URL('../docs/assets/gallery/', import.meta.url);
  for (const g of gallery) {
    for (const theme of ['light', 'dark']) {
      const file = new URL(`${gallerySlug(g.repo)}-${theme}.jpg`, assetsDir);
      assert.ok(fs.existsSync(file), `missing screenshot for ${g.repo}: ${file.pathname}`);
    }
  }
});
