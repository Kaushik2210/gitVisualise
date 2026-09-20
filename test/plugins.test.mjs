// The contract every language plug-in must satisfy (see the header of core/languages.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLUGINS, PLUGIN_BY_EXT, PACKAGE_EXTS, PLUGIN_LANG_NAMES } from '../skills/repo-architecture/scripts/lib/core/languages.mjs';
import { UNIT_EXT } from '../skills/repo-architecture/scripts/lib/core/scan-core.mjs';

test('plug-ins: unique names and extensions, each with the required members', () => {
  assert.ok(PLUGINS.length >= 2);
  const names = PLUGINS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'names are unique');
  const exts = PLUGINS.flatMap((p) => p.exts);
  assert.equal(new Set(exts).size, exts.length, 'an extension belongs to exactly one plug-in');
  for (const p of PLUGINS) {
    assert.ok(p.name && Array.isArray(p.exts) && p.exts.length, `${p.name}: name and exts`);
    assert.ok(p.exts.every((e) => e === e.toLowerCase() && !e.startsWith('.')), `${p.name}: extensions are lowercase and have no dot`);
    assert.equal(typeof p.parse, 'function', `${p.name}: parse`);
    assert.equal(typeof p.prepare, 'function', `${p.name}: prepare`);
    assert.equal(typeof p.resolve, 'function', `${p.name}: resolve`);
    assert.equal(typeof p.packageUnit, 'boolean', `${p.name}: packageUnit is declared`);
    for (const e of p.exts) assert.ok(p.langNames && p.langNames[e], `${p.name}: a display name for .${e}`);
  }
});

test('plug-ins: registry helpers agree with the plug-ins, and the scanner treats every extension as a diagram unit', () => {
  for (const p of PLUGINS) {
    for (const e of p.exts) {
      assert.equal(PLUGIN_BY_EXT[e], p);
      assert.ok(UNIT_EXT.has(e), `.${e} is a unit extension`);
      assert.equal(PACKAGE_EXTS.has(e), p.packageUnit);
      assert.ok(PLUGIN_LANG_NAMES[e]);
    }
  }
});

test('plug-ins: robust on empty and hostile input, and never resolve to something that was not asked about', () => {
  const hostile = ['', '\n\n', '\0\0\0', 'import ' + 'x'.repeat(50000), '{{{{[[[[((((', 'use ' + '::'.repeat(2000) + ';', '#include "' + '../'.repeat(500) + 'x.h"'];
  for (const p of PLUGINS) {
    for (const ext of p.exts) {
      for (const text of hostile) {
        const parsed = p.parse(text, ext);
        assert.ok(parsed && Array.isArray(parsed.imports), `${p.name}: parse returns imports for ${JSON.stringify(text.slice(0, 12))}`);
        for (const i of parsed.imports) assert.ok(typeof i.spec === 'string' && Number.isInteger(i.line) && i.line >= 1, `${p.name}: import shape`);
      }
    }
    const prepared = p.prepare({ files: [], allPaths: [], read: () => null }) || {};
    const r = p.resolve({ spec: 'no.such.thing', line: 1, names: [] }, prepared.state, { path: `x.${p.exts[0]}`, _text: '', package: '' }) || {};
    assert.ok(!r.files || r.files.length === 0, `${p.name}: an import in an empty repository resolves to no file`);
    assert.ok(!r.external, `${p.name}: and to no external (no manifest declares it)`);
  }
});
