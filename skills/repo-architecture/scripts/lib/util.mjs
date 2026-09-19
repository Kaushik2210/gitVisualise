// Small shared helpers. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export { esc, slug, countLines, githubUrl } from './core/text.mjs';

export const toPosix = (p) => p.split(path.sep).join('/');

export function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** True only when `root` is itself the top level of a git work tree (so repo info describes *this* project). */
export function isGitRoot(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!top) return false;
  const norm = (p) => path.resolve(p).toLowerCase();
  return norm(top) === norm(root);
}

/** Exact-case existence check (Windows/macOS file systems are case-insensitive, GitHub is not). */
export function existsExact(root, rel) {
  if (!rel || path.isAbsolute(rel)) return null;
  const segs = rel.split('/').filter(Boolean);
  if (segs.includes('..')) return null;
  let cur = root;
  for (const seg of segs) {
    let names;
    try {
      names = fs.readdirSync(cur);
    } catch {
      return null;
    }
    if (!names.includes(seg)) return null;
    cur = path.join(cur, seg);
  }
  return fs.statSync(cur).isDirectory() ? 'dir' : 'file';
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
