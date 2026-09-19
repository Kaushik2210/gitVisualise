// Shared fixtures for tests that build throwaway repositories.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates a temp repo from { "path": "contents" } and returns its root. */
export function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gvlang-'));
  for (const [rel, txt] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), txt);
  }
  return root;
}
/** The resolved import targets of a file, as "spec -> resolved|null". */
export const imports = (scan, file) => Object.fromEntries(scan.files.find((f) => f.path === file).imports.map((i) => [i.spec, i.resolved]));
export const externals = (scan) => scan.externals.map((e) => e.name).sort();
