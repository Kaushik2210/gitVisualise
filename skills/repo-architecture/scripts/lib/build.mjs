// Node adapter: builds the static site (index.html + viewer.js + viewer.css) on disk.
import fs from 'node:fs';
import path from 'node:path';
import { diskView } from './validate.mjs';
import { buildSnippets as coreSnippets, renderPage } from './core/build-core.mjs';

export { srcKey } from './core/build-core.mjs';

export function buildSnippets(arch, root) {
  return coreSnippets(arch, diskView(root));
}

export function build({ arch, root, outDir, viewerDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const snippets = buildSnippets(arch, root);
  const template = fs.readFileSync(path.join(viewerDir, 'index.template.html'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'index.html'), renderPage({ arch, snippets, template }));
  for (const f of ['viewer.js', 'viewer.css']) fs.copyFileSync(path.join(viewerDir, f), path.join(outDir, f));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  return { snippets: Object.keys(snippets).length };
}
