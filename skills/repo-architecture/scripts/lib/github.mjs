// Resolves a CLI target (local path, GitHub URL, or owner/repo) to a local directory, cloning if needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function parseTarget(arg) {
  const a = String(arg || '.').trim();
  let m =
    a.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+).*)?\/?$/) ||
    a.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ||
    a.match(/^github:([\w.-]+)\/([\w.-]+)$/);
  if (!m && /^[\w.-]+\/[\w.-]+$/.test(a) && !fs.existsSync(a)) m = [a, ...a.split('/')];
  if (m) return { type: 'github', owner: m[1], repo: m[2], ref: m[3] || null, url: `https://github.com/${m[1]}/${m[2]}` };
  return { type: 'local', dir: path.resolve(a) };
}

export function cloneDir(t) {
  return path.join(process.env.GITVISUALISE_CACHE || path.join(os.homedir(), '.gitvisualise', 'repos'), `${t.owner}__${t.repo}`);
}

/** Shallow-clones (or refreshes) a public GitHub repo. Uses plain `git`; private repos work if git is authenticated. */
export function ensureClone(t, ref) {
  const dir = cloneDir(t);
  const run = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const want = ref || t.ref;
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      run(['fetch', '--depth', '1', 'origin', want || 'HEAD'], dir);
      run(['checkout', '--force', 'FETCH_HEAD'], dir);
    } else {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      run(['clone', '--depth', '1', ...(want ? ['--branch', want] : []), t.url + '.git', dir]);
    }
  } catch (e) {
    throw new Error(`git could not clone ${t.url}${want ? ` @ ${want}` : ''}: ${(e.stderr || e.message || '').toString().trim().split('\n').pop()}`);
  }
  return dir;
}
