#!/usr/bin/env node
// Assembles the website into docs/ (what GitHub Pages serves).
//   site/*                              -> docs/            (landing page, app logic, styles)
//   skills/.../scripts/lib/core, web    -> docs/lib/        (the SAME scan/generate/validate code the CLI uses)
//   skills/.../viewer                   -> docs/viewer/     (the tour player)
// docs/architecture/ (this project's own tour) is left alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(ROOT, 'skills', 'repo-architecture');
const OUT = path.join(ROOT, 'docs');

const copies = [
  ['site/index.html', 'index.html'],
  ['site/app.css', 'app.css'],
  ['site/app.js', 'app.js'],
];
const addDir = (srcDir, destDir, filter = () => true) => {
  for (const f of fs.readdirSync(path.join(ROOT, srcDir))) if (filter(f)) copies.push([`${srcDir}/${f}`, `${destDir}/${f}`]);
};
addDir('skills/repo-architecture/scripts/lib/core', 'lib/core', (f) => f.endsWith('.mjs'));
addDir('skills/repo-architecture/scripts/lib/web', 'lib/web', (f) => f.endsWith('.mjs'));
copies.push(['skills/repo-architecture/scripts/lib/generate.mjs', 'lib/generate.mjs']);
for (const f of ['index.template.html', 'viewer.js', 'viewer.css']) copies.push([`skills/repo-architecture/viewer/${f}`, `viewer/${f}`]);

// Start clean for generated folders so deleted source files do not linger.
for (const dir of ['lib', 'viewer']) fs.rmSync(path.join(OUT, dir), { recursive: true, force: true });

for (const [from, to] of copies) {
  const dest = path.join(OUT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Normalise to LF so output is identical on every OS (CI compares it with what is committed).
  fs.writeFileSync(dest, fs.readFileSync(path.join(ROOT, from), 'utf8').replace(/\r\n/g, '\n'));
}
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`site built: ${copies.length} files -> docs/`);
