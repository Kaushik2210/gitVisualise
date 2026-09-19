// Node adapter for the scanner: walks a directory, reads files, asks git for repo info,
// then hands everything to the pure core (which also runs in the browser).
import fs from 'node:fs';
import path from 'node:path';
import { toPosix, readText, git, isGitRoot, githubUrl } from './util.mjs';
import { scanCore, makeIgnorer, IGNORE_DIRS } from './core/scan-core.mjs';

const MAX_FILES = 20000;
const MAX_READ = 512 * 1024;

function walk(root, ignorer, ignoreExtra) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < MAX_FILES) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || ignoreExtra.has(childRel) || ignorer(childRel, true)) continue;
        stack.push(childRel);
      } else if (e.isFile()) {
        if (ignorer(childRel, false)) continue;
        files.push(childRel);
      }
    }
  }
  return files.sort();
}

export function scanRepo(root, opts = {}) {
  root = path.resolve(root);
  const ignoreExtra = new Set((opts.ignore || []).map((p) => p.replace(/^\.?\//, '').replace(/\/$/, '')));
  const ignoreLines = [
    ...(readText(path.join(root, '.gitignore')) || '').split('\n'),
    ...(readText(path.join(root, '.gitvisualiseignore')) || '').split('\n'),
  ];
  const paths = walk(root, makeIgnorer(ignoreLines), ignoreExtra);

  const read = (rel) => {
    try {
      const abs = path.join(root, rel);
      return fs.statSync(abs).size <= MAX_READ ? fs.readFileSync(abs, 'utf8') : null;
    } catch {
      return null;
    }
  };

  const repo = { name: opts.name || path.basename(root), url: null, branch: null, commit: null };
  if (isGitRoot(root)) {
    repo.url = githubUrl(git(root, ['remote', 'get-url', 'origin']));
    repo.branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    repo.commit = git(root, ['rev-parse', 'HEAD']);
    repo.dirty = (git(root, ['status', '--porcelain', '--untracked-files=no']) || '').length > 0;
  }
  if (opts.repoUrl) repo.url = opts.repoUrl;
  if (opts.ref) repo.branch = opts.ref;

  return scanCore({ paths, read, repo, root: toPosix(root) });
}
