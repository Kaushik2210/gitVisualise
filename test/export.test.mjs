// Mermaid / PlantUML export and the README badge snippet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toMermaid, toPlantUml, mermaidText, plantText } from '../skills/repo-architecture/scripts/lib/core/export-core.mjs';
import { badgeMarkdown, tourUrl } from '../skills/repo-architecture/scripts/lib/web/route.mjs';
import { parseRepoInput } from '../skills/repo-architecture/scripts/lib/web/github-loader.mjs';
import { diffArchitectures } from '../skills/repo-architecture/scripts/lib/core/diff-core.mjs';

const src = [{ path: 'x.js' }];
const arch = {
  schemaVersion: 1, project: { name: 'demo' },
  nodes: [
    { id: 'a', label: 'App "main" <core>', kind: 'entry', group: 'Backend', sources: src },
    { id: 'b', label: 'db #1', kind: 'data', group: 'Backend', sources: src },
    { id: 'c', label: 'Web', kind: 'ui', sources: src },
    { id: 'd', label: 'odd', kind: 'weird kind!', sources: src },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b', kind: 'imports', label: 'uses |pipe|' },
    { id: 'e2', from: 'c', to: 'a', kind: 'http', label: 'GET /x' },
    { id: 'e3', from: 'c', to: 'zzz', kind: 'imports' },
  ],
  flows: [],
};

test('mermaid: escapes repository text so it cannot break the syntax', () => {
  assert.equal(mermaidText('a "b" <c> #d'), 'a #quot;b#quot; #lt;c#gt; #35;d');
  assert.ok(mermaidText('x'.repeat(100)).length <= 60);
  const out = toMermaid(arch);
  assert.match(out, /^flowchart LR\n/);
  assert.ok(!/App "main"/.test(out), 'raw quotes never reach the diagram');
  assert.match(out, /n0\["App #quot;main#quot; #lt;core#gt;<br\/>entry"\]:::k_entry/);
  // ids are generated, never copied from repository data
  assert.ok(!/\bn[a-z]{2,}\b\[/.test(out));
});

test('mermaid: groups become subgraphs, http edges are dotted, edges to unknown nodes are skipped', () => {
  const out = toMermaid(arch);
  assert.match(out, /subgraph g0\["Backend"\]\n\s+n0\[.*\n\s+n1\[.*\n\s+end/);
  assert.match(out, /n2 -\.->\|"GET \/x"\| n0/);
  assert.match(out, /n0 -->\|"uses \|pipe\|"\| n1/);
  assert.ok(!/zzz/.test(out) && (out.match(/-->|-\.->/g) || []).length === 2);
  assert.match(out, /classDef k_weird_kind_ /);
  assert.match(toMermaid(arch, { direction: 'TB' }), /^flowchart TB/);
});

test('mermaid: a comparison colours added, removed and changed', () => {
  const head = { ...arch, nodes: [...arch.nodes.filter((n) => n.id !== 'd'), { id: 'n', label: 'New', kind: 'service', sources: src }], edges: arch.edges };
  head.nodes[0] = { ...head.nodes[0], summary: 'changed now' };
  const base = { ...arch, nodes: arch.nodes.map((n) => ({ ...n, summary: n.id === 'a' ? 'old' : undefined })) };
  const { arch: d } = diffArchitectures(base, head, { baseRef: 'v1', headRef: 'v2' });
  const out = toMermaid(d);
  assert.match(out, /:::d_added/);
  assert.match(out, /:::d_removed/);
  assert.match(out, /:::d_changed/);
  assert.match(out, /classDef d_added fill:#dcfce7,stroke:#16a34a/);
});

test('plantuml: valid skeleton with escaped labels, packages for groups and dotted http edges', () => {
  assert.equal(plantText('say "hi"' + String.fromCharCode(92) + 'now'), "say 'hi'/now");
  const out = toPlantUml(arch);
  assert.match(out, /^@startuml\nleft to right direction/);
  assert.match(out, /package "Backend" \{\n\s+rectangle "App 'main' <core>/);
  assert.match(out, /n2 \.\.> n0 : GET \/x/);
  assert.match(out, /@enduml\n$/);
});

test('badge: links to the tour for a repo, ref, folder or comparison, safely encoded', () => {
  const md = (s) => badgeMarkdown(parseRepoInput(s));
  assert.equal(md('tj/commander.js'), '[![Architecture tour](https://img.shields.io/badge/architecture-tour-8db3ff?logo=github&logoColor=white)](https://kaushik2210.github.io/gitVisualise/#/tj/commander.js)');
  assert.match(md('o/r@v1...v2'), /\(https:\/\/kaushik2210\.github\.io\/gitVisualise\/#\/o\/r@v1\.\.\.v2\)$/);
  assert.match(md('o/r:apps/web'), /#\/o\/r:apps\/web\)$/);
  const tricky = tourUrl({ owner: 'o', repo: 'r', ref: null, path: 'a b/(x)' });
  assert.ok(!/[ ()]/.test(tricky.slice(tricky.indexOf('#'))), tricky);
  assert.throws(() => badgeMarkdown(null), /Not a GitHub repository/);
});

test('cli: export prints Mermaid or writes a file, and refuses unknown input', () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills/repo-architecture/scripts/gitvisualise.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvexp-'));
  fs.writeFileSync(path.join(dir, 'architecture.json'), JSON.stringify(arch));
  assert.match(execFileSync('node', [cli, 'export', dir], { encoding: 'utf8' }), /^flowchart LR/);
  const out = path.join(dir, 'out', 'a.puml');
  execFileSync('node', [cli, 'export', dir, '--format', 'plantuml', '--out', out]);
  assert.match(fs.readFileSync(out, 'utf8'), /^@startuml/);
  assert.throws(() => execFileSync('node', [cli, 'export', dir, '--format', 'dot'], { stdio: 'pipe' }), /Unknown format/);
});
