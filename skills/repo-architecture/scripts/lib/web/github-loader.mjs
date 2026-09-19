// Analyse a GitHub repository entirely from a browser (or Node 18+): no server, no clone, no keys.
//
//   api.github.com  -> commit sha + full file tree (2 requests)
//   raw.githubusercontent.com -> file contents (no API rate limit; CORS enabled)
//
// A personal access token is optional: it raises the API rate limit and unlocks private repos.
// The heavy lifting (scan, generate, validate) is the exact same pure code the CLI uses.
import { scanCore, makeIgnorer, filterPaths, UNIT_EXT, TEST_RE, extOf } from '../core/scan-core.mjs';
import { validateCore } from '../core/validate-core.mjs';
import { generate, isExamplePath, TOOLING_RE } from '../generate.mjs';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const CURATED_PATH = 'docs/architecture/architecture.json';
const MAX_FILE_BYTES = 512 * 1024;

export class GitHubError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind; // bad_input | not_found | rate_limit | auth | network | empty
    Object.assign(this, extra);
  }
}

/** Accepts URLs, git@ remotes, "owner/repo", and "owner/repo@ref". Returns null when it is not a GitHub repo. */
export function parseRepoInput(input) {
  const s = String(input || '').trim().replace(/\s+/g, '');
  if (!s) return null;
  const NAME = '[\\w.-]+';
  let m =
    s.match(new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/(${NAME})\\/(${NAME}?)(?:\\.git)?(?:\\/(?:tree|blob|commit)\\/([^/#?]+).*)?\\/?(?:[?#].*)?$`, 'i')) ||
    s.match(new RegExp(`^git@github\\.com:(${NAME})\\/(${NAME}?)(?:\\.git)?$`, 'i')) ||
    s.match(new RegExp(`^github:(${NAME})\\/(${NAME})$`, 'i')) ||
    s.match(new RegExp(`^(${NAME})\\/(${NAME})(?:@([^/#?]+))?$`));
  if (!m) return null;
  const [, owner, repo, ref] = m;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return { owner, repo: repo.replace(/\.git$/i, ''), ref: ref || null };
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

function rateInfo(res) {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  return { remaining: remaining == null ? null : Number(remaining), reset: reset ? new Date(Number(reset) * 1000) : null };
}

async function request(url, { token, accept, signal, fetchImpl, api = true }) {
  const headers = {};
  if (accept) headers.Accept = accept;
  if (token && api) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchImpl(url, { headers, signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new GitHubError('network', 'Could not reach GitHub. Check your connection and try again.');
  }
  return res;
}

async function apiGet(path, o) {
  const res = await request(API + path, o);
  if (res.ok) return res;
  const info = rateInfo(res);
  if (res.status === 404) throw new GitHubError('not_found', 'Repository not found. It may be private, misspelled, or renamed.', { hasToken: !!o.token });
  if (res.status === 401) throw new GitHubError('auth', 'GitHub rejected that token. Check that it is valid and has read access to the repository.');
  if (res.status === 403 || res.status === 429) {
    let body = '';
    try { body = (await res.text()).toLowerCase(); } catch { /* ignore */ }
    if (info.remaining === 0 || body.includes('rate limit')) {
      throw new GitHubError('rate_limit', 'GitHub\'s hourly limit for anonymous requests was reached.', { resetAt: info.reset, hasToken: !!o.token });
    }
    throw new GitHubError('auth', 'GitHub denied access to this repository.');
  }
  throw new GitHubError('network', `GitHub returned an unexpected error (${res.status}).`);
}

async function fetchText(owner, repo, sha, path, o) {
  if (o.token) {
    // Raw hosts do not reliably accept auth headers cross-origin; the contents API does (and covers private repos).
    const res = await request(`${API}/repos/${owner}/${repo}/contents/${encPath(path)}?ref=${sha}`, { ...o, accept: 'application/vnd.github.raw+json' });
    return res.ok ? res.text() : null;
  }
  const res = await request(`${RAW}/${owner}/${repo}/${sha}/${encPath(path)}`, { ...o, api: false });
  return res.ok ? res.text() : null;
}

async function pool(items, limit, worker, signal) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** A read-only view of the repo (the same shape the CLI validator uses), backed by the tree + downloaded files. */
export function makeView(paths, contents) {
  const files = new Set(paths);
  const dirs = new Set();
  for (const p of paths) {
    const s = p.split('/');
    for (let i = 1; i < s.length; i++) dirs.add(s.slice(0, i).join('/'));
  }
  let names = null;
  return {
    exists: (rel) => (files.has(rel) ? 'file' : dirs.has(rel) ? 'dir' : null),
    read: (rel) => (contents.has(rel) ? contents.get(rel) : null),
    list: (rel) => {
      const prefix = rel ? rel.replace(/\/$/, '') + '/' : '';
      const out = new Set();
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length).split('/');
        out.add(rest.length > 1 ? rest[0] + '/' : rest[0]);
      }
      return [...out].sort();
    },
    hasBasename: (name) => {
      if (!names) names = new Set(paths.map((p) => p.slice(p.lastIndexOf('/') + 1)));
      return names.has(name);
    },
  };
}

// Small files the scanner reads besides source: dependency manifests, workspace definitions, and the configs that
// define import aliases (tsconfig/jsconfig paths, Vite and webpack aliases).
const MANIFEST_RE = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|go\.work|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|pnpm-workspace\.yaml|(tsconfig|jsconfig)[^/]*\.json|(vite|webpack)\.config\.[cm]?[jt]s)$/;
const ENTRY_HINT = /(^|\/)(main|index|app|server|cli|__main__|manage|__init__)\.[a-z]+$/i;

/** Decides which source files to download: skip tests/examples/tooling, prefer shallow + entry-like files. */
export function pickSourceFiles(paths, sizes, maxFiles) {
  const skipped = { tests: 0, examples: 0, tooling: 0 };
  const candidates = [];
  for (const p of paths) {
    if (!UNIT_EXT.has(extOf(p)) || (sizes.get(p) || 0) > MAX_FILE_BYTES) continue;
    if (TEST_RE.test(p)) { skipped.tests++; continue; }
    if (isExamplePath(p)) { skipped.examples++; continue; }
    if (TOOLING_RE.test(p)) { skipped.tooling++; continue; }
    candidates.push(p);
  }
  const rank = (p) => (ENTRY_HINT.test(p) ? 0 : 1);
  candidates.sort((a, b) => a.split('/').length - b.split('/').length || rank(a) - rank(b) || a.localeCompare(b));
  return { chosen: candidates.slice(0, maxFiles), total: candidates.length, skipped };
}

function collectSourcePaths(arch) {
  const set = new Set();
  const add = (arr) => (arr || []).forEach((s) => s && typeof s.path === 'string' && set.add(s.path.replace(/\/$/, '')));
  (arch.nodes || []).forEach((n) => add(n.sources));
  (arch.edges || []).forEach((e) => add(e.sources));
  (arch.flows || []).forEach((f) => (f.steps || []).forEach((s) => add(s.sources)));
  return [...set];
}

/** Resolves a repository ref (default branch when omitted) to a commit SHA with a single API request. */
export async function resolveCommit(target, { token, signal, fetchImpl = globalThis.fetch } = {}) {
  const { owner, repo, ref } = target;
  const res = await apiGet(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref || 'HEAD')}`, { token, signal, fetchImpl, accept: 'application/vnd.github.sha' });
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new GitHubError('not_found', ref ? `Could not find "${ref}" in ${owner}/${repo}.` : 'Repository has no commits to analyse.');
  return { sha, rate: rateInfo(res) };
}

/**
 * Full pipeline. Returns { arch, view, validation, meta }.
 * opts: { token, signal, onProgress(evt), fetchImpl, maxFiles, preferCurated }
 * progress events: { stage: 'resolve'|'tree'|'download'|'analyse', done?, total? }
 */
export async function analyzeRepo(input, opts = {}) {
  const { token, signal, onProgress = () => {}, fetchImpl = globalThis.fetch, maxFiles = 300, preferCurated = true } = opts; // opts.sha: a commit already resolved with resolveCommit()
  const target = typeof input === 'string' ? parseRepoInput(input) : input;
  if (!target) throw new GitHubError('bad_input', 'That does not look like a GitHub repository. Try owner/repo or a github.com link.');
  const { owner, repo, ref } = target;
  const o = { token, signal, fetchImpl };
  let rate = { remaining: null, reset: null };

  let sha = opts.sha;
  if (!sha) {
    onProgress({ stage: 'resolve' });
    const r = await resolveCommit({ owner, repo, ref }, { token, signal, fetchImpl });
    sha = r.sha;
    rate = r.rate;
  } else if (opts.rate) rate = opts.rate;

  onProgress({ stage: 'tree' });
  const treeRes = await apiGet(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, { ...o, accept: 'application/vnd.github+json' });
  rate = rateInfo(treeRes);
  const tree = await treeRes.json();
  const blobs = (tree.tree || []).filter((t) => t.type === 'blob');
  const sizes = new Map(blobs.map((b) => [b.path, b.size || 0]));
  const allPaths = blobs.map((b) => b.path).sort();
  if (!allPaths.length) throw new GitHubError('empty', 'This repository has no files.');

  const contents = new Map();
  const download = async (list, label) => {
    let done = 0;
    onProgress({ stage: 'download', done, total: list.length, label });
    await pool(list, 8, async (p) => {
      let text = null;
      try { text = await fetchText(owner, repo, sha, p, o); } catch (e) { if (e && e.name === 'AbortError') throw e; }
      if (text != null) contents.set(p, text.replace(/\r\n/g, '\n'));
      onProgress({ stage: 'download', done: ++done, total: list.length, label });
    }, signal);
  };

  const repoUrl = `https://github.com/${owner}/${repo}`;
  const meta = { owner, repo, ref, sha, repoUrl, truncated: !!tree.truncated, totalFiles: allPaths.length, rate, curated: false };

  // 1) Prefer the tour the repository's own authors published (docs/architecture/architecture.json).
  if (preferCurated && sizes.has(CURATED_PATH)) {
    await download([CURATED_PATH], 'curated tour');
    let curated = null;
    try { curated = JSON.parse(contents.get(CURATED_PATH)); } catch { /* fall through to analysis */ }
    if (curated && curated.schemaVersion === 1 && Array.isArray(curated.nodes) && Array.isArray(curated.edges) && Array.isArray(curated.flows) && curated.nodes.length) {
      const refs = collectSourcePaths(curated).filter((p) => sizes.has(p) && (sizes.get(p) || 0) <= MAX_FILE_BYTES).slice(0, 150);
      await download(refs, 'referenced source files');
      onProgress({ stage: 'analyse' });
      curated.project = { ...(curated.project || {}), repoUrl, commit: sha, branch: ref || null, dirty: undefined };
      const view = makeView(allPaths, contents);
      const validation = validateCore(curated, view);
      return { arch: curated, view, validation, meta: { ...meta, curated: true, analysed: refs.length } };
    }
  }

  // 2) Otherwise analyse the code.
  const ignoreText = sizes.has('.gitignore') ? (await fetchText(owner, repo, sha, '.gitignore', o)) : null;
  const paths = filterPaths(allPaths, makeIgnorer((ignoreText || '').split('\n')));
  const manifests = paths.filter((p) => MANIFEST_RE.test(p) && p.split('/').length <= 3);
  const readme = paths.find((p) => /^readme(\.md|\.rst|\.txt)?$/i.test(p));
  const picked = pickSourceFiles(paths, sizes, maxFiles);
  if (!picked.chosen.length) throw new GitHubError('empty', 'No analysable source files were found (supported: JavaScript/TypeScript, Python, Go, Java, Rust and more, as structure only). This may be a docs-only or asset-only repository.');
  await download([...manifests, ...(readme ? [readme] : []), ...picked.chosen], 'source files');

  onProgress({ stage: 'analyse' });
  const scan = scanCore({ paths, read: (p) => (contents.has(p) ? contents.get(p) : null), repo: { name: repo, url: repoUrl, branch: ref || null, commit: sha }, root: '' });
  const notes = [];
  if (picked.total > picked.chosen.length) notes.push(`Analysed the ${picked.chosen.length} shallowest of ${picked.total} source files.`);
  if (tree.truncated) notes.push('GitHub truncated the file listing for this very large repository, so the picture is partial.');
  const arch = generate(scan, { alreadySkipped: picked.skipped, extraNotes: notes, noIncludeHint: true });
  arch.project.repoUrl = repoUrl;
  arch.project.generatedBy = 'heuristic';

  const view = makeView(allPaths, contents);
  const validation = validateCore(arch, view);
  return { arch, view, validation, meta: { ...meta, analysed: picked.chosen.length, sourceTotal: picked.total, skipped: picked.skipped } };
}

// ---------- repo picker helpers ----------

/**
 * Lists public repos for a user/org (or the token owner's repos when `user` is empty and a token is given).
 * Follows GitHub's pagination up to `maxPages` pages of 100 and returns every repository found. The array carries two
 * extra properties: `capped` (more pages existed than were read) and `error` (a later page failed, so the list is partial).
 * `onPage(reposSoFar)` is called after each page so a UI can render progressively.
 */
export async function listRepos({ user, token, signal, fetchImpl = globalThis.fetch, maxPages = 10, onPage }) {
  if (!user && !token) throw new GitHubError('bad_input', 'Enter a GitHub username, or add a token to list your own repositories.');
  const base = user
    ? `/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`
    : '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';
  const repos = [];
  repos.capped = false;
  repos.error = null;
  for (let page = 1; page <= maxPages; page++) {
    let res;
    try {
      res = await apiGet(`${base}&page=${page}`, { token, signal, fetchImpl, accept: 'application/vnd.github+json' });
    } catch (e) {
      if (page === 1 || (e && e.name === 'AbortError')) throw e; // nothing to show yet: report it as usual
      repos.error = e; // keep what we already have
      break;
    }
    const list = await res.json();
    for (const r of list) repos.push({ fullName: r.full_name, name: r.name, description: r.description || '', language: r.language || '', stars: r.stargazers_count || 0, updated: r.pushed_at || r.updated_at, private: !!r.private, fork: !!r.fork });
    if (onPage) onPage(repos.slice());
    const link = res.headers.get('link');
    const hasNext = link ? /rel="next"/.test(link) : list.length === 100;
    if (!hasNext) return repos;
    if (page === maxPages) repos.capped = true;
  }
  return repos;
}
