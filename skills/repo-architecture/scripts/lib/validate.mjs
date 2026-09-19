// Node adapter: validates architecture.json against a repository on disk.
import fs from 'node:fs';
import path from 'node:path';
import { existsExact, readText } from './util.mjs';
import { validateCore } from './core/validate-core.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'venv', '.venv', '__pycache__', 'target']);

/** A repository view backed by the file system. */
export function diskView(root) {
  root = path.resolve(root);
  let names = null;
  return {
    exists: (rel) => existsExact(root, rel),
    read: (rel) => {
      const t = readText(path.join(root, rel));
      return t == null ? null : t.replace(/\r\n/g, '\n');
    },
    list: (rel) => {
      try {
        return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? '/' : ''));
      } catch {
        return [];
      }
    },
    hasBasename: (name) => {
      if (!names) {
        names = new Set();
        const stack = [root];
        while (stack.length && names.size < 100000) {
          const dir = stack.pop();
          let ents = [];
          try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
          for (const e of ents) {
            if (e.isDirectory() && !SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
            names.add(e.name);
          }
        }
      }
      return names.has(name);
    },
  };
}

export function validate(arch, root) {
  return validateCore(arch, diskView(root));
}

export function readArchitecture(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
