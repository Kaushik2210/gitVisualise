// Deterministic repository scanner core. Produces *facts* (files, imports, entry points, dependencies)
// that both the heuristic generator and Claude use, so architecture is grounded in the repo.
// Pure: works on a list of paths plus a read() callback, so it runs unchanged in Node and in the browser.
import * as posix from './posix.mjs';
import { countLines } from './text.mjs';

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'venv', '.venv', 'env',
  '__pycache__', 'target', 'vendor', '.idea', '.vscode', '.gitvisualise', '.turbo', '.parcel-cache',
  'bower_components', '.gradle', '.svelte-kit', '.pytest_cache', '.mypy_cache', '.tox', 'site-packages',
]);

const LANG = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
  vue: 'Vue', svelte: 'Svelte', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby',
  php: 'PHP', cs: 'C#', c: 'C', h: 'C', cpp: 'C++', swift: 'Swift', html: 'HTML', css: 'CSS', scss: 'SCSS',
  json: 'JSON', md: 'Markdown', yml: 'YAML', yaml: 'YAML', sh: 'Shell', sql: 'SQL',
};
// Files that become diagram units.
export const UNIT_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs', 'html']);
const JS_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.json'];
export const TEST_RE = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)(-d)?\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;

export const KNOWN_EXTERNAL = {
  react: 'ui', 'react-dom': 'ui', vue: 'ui', svelte: 'ui', next: 'ui', angular: 'ui', '@angular/core': 'ui',
  express: 'api', fastify: 'api', koa: 'api', hono: 'api', flask: 'api', fastapi: 'api', django: 'api',
  axios: 'external', 'node-fetch': 'external', requests: 'external',
  mongoose: 'data', mongodb: 'data', pg: 'data', mysql2: 'data', sequelize: 'data', prisma: 'data', '@prisma/client': 'data',
  redis: 'data', sqlalchemy: 'data', typeorm: 'data', firebase: 'data', 'better-sqlite3': 'data',
  'react-router-dom': 'ui', 'react-router': 'ui', leaflet: 'ui', 'react-leaflet': 'ui', tailwindcss: 'ui',
};

/** Builds an ignore predicate from .gitignore-style lines (simple patterns only: names, dir/, /anchored, *.ext). */
export function makeIgnorer(rawLines) {
  const rules = rawLines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => {
      const anchored = l.startsWith('/');
      let p = l.replace(/^\//, '');
      const dirOnly = p.endsWith('/');
      p = p.replace(/\/$/, '');
      if (p.startsWith('*.')) return { ext: p.slice(1), anchored, dirOnly };
      if (p.includes('*')) return null;
      return { name: p, anchored, dirOnly };
    })
    .filter(Boolean);
  return (rel, isDir) => {
    const base = rel.split('/').pop();
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue; // files below an ignored dir are never visited
      if (r.ext) {
        if (base.endsWith(r.ext)) return true;
      } else if (r.anchored || r.name.includes('/')) {
        if (rel === r.name || rel.startsWith(r.name + '/')) return true;
      } else if (base === r.name) return true;
    }
    return false;
  };
}

/** Filters a flat list of repo paths the same way the directory walker does (used for GitHub trees). */
export function filterPaths(paths, ignorer, ignoreExtra = new Set()) {
  return paths.filter((p) => {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      if (IGNORE_DIRS.has(segs[i - 1]) || ignoreExtra.has(dir) || ignorer(dir, true)) return false;
    }
    return !ignorer(p, false);
  });
}

export const extOf = (p) => (p.includes('.') ? p.split('.').pop().toLowerCase() : '');

// A leading comment only describes the *file* when it is not the doc comment of the first declaration.
const DECL_RE = /^\s*(export\s+)?(default\s+)?(async\s+)?(abstract\s+)?(class|function|interface|type|enum|const|let|var|def)\b|^\s*@\w/;
function attachedToDecl(text, end) {
  const rest = text.slice(end).replace(/^[ \t]*\n/, '');
  if (/^[ \t]*\n/.test(rest)) return false;
  return DECL_RE.test(rest.split('\n')[0]);
}
function firstDoc(text, ext) {
  if (!text) return null;
  let m;
  if (ext === 'py') {
    m = text.match(/^\s*(?:#![^\n]*\n)?\s*(?:"""|''')([\s\S]*?)(?:"""|''')/);
    if (m) return clean(m[1]);
  }
  m = text.match(/^\s*(?:#![^\n]*\n)?\s*\/\*\*?([\s\S]*?)\*\//);
  if (m) return attachedToDecl(text, m.index + m[0].length) ? null : clean(m[1].replace(/^\s*\*\s?/gm, ''));
  m = text.match(/^\s*((?:\/\/[^\n]*\n?)+)/);
  if (m) return attachedToDecl(text, m.index + m[0].length) ? null : clean(m[1].replace(/^\s*\/\/\s?/gm, ''));
  m = text.match(/^\s*((?:#[^\n!][^\n]*\n?)+)/);
  if (m && ext === 'py') return clean(m[1].replace(/^\s*#\s?/gm, ''));
  m = text.match(/<!--([\s\S]*?)-->/);
  if (m && ext === 'html') return clean(m[1]);
  return null;
}
function clean(s) {
  const t = s
    .replace(/<https?:[^>]*>/g, '').replace(/https?:\/\/\S+/g, '')
    .replace(/([~=\-*#^+_])\1{2,}/g, ' ') // RST/markdown underlines
    .replace(/\s+/g, ' ').trim();
  if (t.replace(/[^A-Za-z]/g, '').length < t.length * 0.6) return null; // ASCII art / banners, not prose
  if (!t || /^(eslint|@ts-|prettier|copyright|license|use strict)/i.test(t)) return null;
  const sentence = t.match(/^(.{20,}?[.!?])(\s|$)/);
  const out = sentence ? sentence[1] : t;
  return out.length > 220 ? out.slice(0, 217) + '...' : out;
}

function symbolsOf(text, ext) {
  const out = [];
  const push = (name, idx) => {
    if (name && out.length < 12 && !out.some((s) => s.name === name)) out.push({ name, line: text.slice(0, idx).split('\n').length });
  };
  let re, m;
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)) {
    re = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = re.exec(text))) push(m[1], m.index);
    re = /^(?:async\s+)?function\s+([A-Z][\w$]*)\s*\(/gm; // components / top-level named functions
    while ((m = re.exec(text))) push(m[1], m.index);
  } else if (ext === 'py') {
    re = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm;
    while ((m = re.exec(text))) if (!m[1].startsWith('_')) push(m[1], m.index);
  } else if (ext === 'go') {
    re = /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm;
    while ((m = re.exec(text))) push(m[1], m.index);
  }
  return out;
}

function lineAt(text, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
const isCommentLine = (text, idx) => {
  const start = text.lastIndexOf('\n', idx - 1) + 1;
  return /^\s*(\/\/|\*|\/\*|#)/.test(text.slice(start, idx + 1));
};

function jsImports(text, ext) {
  const out = [];
  const seen = new Set();
  const add = (spec, idx, names) => {
    if (isCommentLine(text, idx)) return;
    const line = lineAt(text, idx);
    const key = spec + '@' + line;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ spec, line, names: names || [] });
  };
  let m;
  const re1 = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
  while ((m = re1.exec(text))) {
    const names = (m[1] || '').replace(/[{}*]/g, ' ').split(/[\s,]+/).filter((s) => s && s !== 'as' && s !== 'type');
    add(m[2], m.index + (m[0].match(/^\s/) ? 1 : 0), names);
  }
  const re2 = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re2.exec(text))) add(m[1], m.index);
  const re3 = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re3.exec(text))) add(m[1], m.index);
  if (ext === 'html') {
    const re4 = /<script[^>]*\ssrc=["']([^"']+)["']/gi;
    while ((m = re4.exec(text))) out.push({ spec: m[1], line: lineAt(text, m.index), names: [] });
  }
  return out;
}

function pyImports(text) {
  const out = [];
  let m;
  const re = /^[ \t]*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm;
  while ((m = re.exec(text))) {
    out.push({ spec: m[1], line: lineAt(text, m.index), names: m[2].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean), py: true });
  }
  const re2 = /^[ \t]*import\s+([\w., ]+)/gm;
  while ((m = re2.exec(text))) {
    for (const mod of m[1].split(',')) {
      const name = mod.trim().split(/\s+as\s+/)[0];
      if (name) out.push({ spec: name, line: lineAt(text, m.index), names: [], py: true });
    }
  }
  return out;
}

function goImports(text) {
  const out = [];
  let m;
  const block = /^import\s*\(([\s\S]*?)\)/gm;
  while ((m = block.exec(text))) {
    const base = lineAt(text, m.index);
    m[1].split('\n').forEach((l, i) => {
      const s = l.match(/"([^"]+)"/);
      if (s) out.push({ spec: s[1], line: base + i, names: [], go: true });
    });
  }
  const single = /^import\s+(?:\w+\s+)?"([^"]+)"/gm;
  while ((m = single.exec(text))) out.push({ spec: m[1], line: lineAt(text, m.index), names: [], go: true });
  return out;
}

function parseManifests(read, all) {
  const manifests = [];
  const set = new Set(all);
  const depNames = new Set();
  const versions = {};
  const depLine = {}; // dep name -> { file, line }
  const findLine = (file, name) => {
    const txt = read(file) || '';
    const i = txt.split('\n').findIndex((l) => l.includes(`"${name}"`) || new RegExp(`^\\s*${name}\\b`, 'i').test(l) || l.includes(name));
    return i >= 0 ? i + 1 : 1;
  };
  for (const file of all.filter((f) => /(^|\/)package\.json$/.test(f) && f.split('/').length <= 3)) {
    let pkg;
    try { pkg = JSON.parse(read(file)); } catch { continue; }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    Object.keys(deps).forEach((d) => {
      depNames.add(d);
      versions[d] = deps[d];
      if (!depLine[d]) depLine[d] = { file, line: findLine(file, d) };
    });
    manifests.push({ file, type: 'npm', name: pkg.name || null, description: pkg.description || null, main: pkg.main || pkg.module || null, bin: pkg.bin || null, scripts: pkg.scripts || {}, dependencies: Object.keys(pkg.dependencies || {}), devDependencies: Object.keys(pkg.devDependencies || {}) });
  }
  for (const file of all.filter((f) => /(^|\/)requirements[^/]*\.txt$/.test(f))) {
    const txt = read(file) || '';
    const names = txt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('-')).map((l) => l.split(/[=<>~!\[; ]/)[0].toLowerCase());
    names.forEach((d) => { depNames.add(d); if (!depLine[d]) depLine[d] = { file, line: findLine(file, d) }; });
    manifests.push({ file, type: 'pip', dependencies: names });
  }
  if (set.has('pyproject.toml')) {
    const txt = read('pyproject.toml') || '';
    const name = (txt.match(/^name\s*=\s*["']([^"']+)/m) || [])[1] || null;
    const block = (txt.match(/dependencies\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
    const names = [...block.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((m) => m[1].toLowerCase());
    names.forEach((d) => { depNames.add(d); if (!depLine[d]) depLine[d] = { file: 'pyproject.toml', line: findLine('pyproject.toml', d) }; });
    manifests.push({ file: 'pyproject.toml', type: 'pyproject', name, description: (txt.match(/^description\s*=\s*["']([^"']+)/m) || [])[1] || null, dependencies: names });
  }
  let goModule = null;
  if (set.has('go.mod')) {
    const txt = read('go.mod') || '';
    goModule = (txt.match(/^module\s+(\S+)/m) || [])[1] || null;
    const reqs = [...txt.matchAll(/^\s*(?:require\s+)?([\w.\-/]+\.[\w.\-/]+)\s+v[\w.\-+]+/gm)].map((m) => m[1]);
    reqs.forEach((d) => { depNames.add(d); if (!depLine[d]) depLine[d] = { file: 'go.mod', line: findLine('go.mod', d) }; });
    manifests.push({ file: 'go.mod', type: 'go', name: goModule, dependencies: reqs });
  }
  if (set.has('Cargo.toml')) {
    const txt = read('Cargo.toml') || '';
    manifests.push({ file: 'Cargo.toml', type: 'cargo', name: (txt.match(/^name\s*=\s*["']([^"']+)/m) || [])[1] || null, dependencies: [] });
  }
  return { manifests, depNames, versions, depLine, goModule };
}

function readmeSummary(read, all) {
  const f = all.find((x) => /^readme(\.md|\.rst|\.txt)?$/i.test(x));
  if (!f) return null;
  const txt = read(f) || '';
  const paras = txt.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^(#|!\[|\[!\[|<|```|[-=]{3,}|\|)/.test(p));
  const p = paras[0];
  if (!p) return null;
  const one = p.replace(/\s+/g, ' ').replace(/[*_`]/g, '');
  return { file: f, text: one.length > 300 ? one.slice(0, 297) + '...' : one };
}

/**
 * Pure scan: no file system, no git, runs in Node and in the browser.
 *   paths: every repo file path to consider (already ignore-filtered), "/"-separated
 *   read(rel): file text, or null when unavailable / too large (such files are skipped)
 *   repo: { name, url, branch, commit, dirty? }
 */
export function scanCore({ paths, read, repo, root = '' }) {
  const all = paths;
  const allSet = new Set(all);

  const { manifests, depNames, versions, depLine, goModule } = parseManifests(read, all);
  const langCount = {};
  const files = [];
  for (const rel of all) {
    const ext = extOf(rel);
    const lang = LANG[ext];
    if (lang) langCount[lang] = (langCount[lang] || 0) + 1;
    if (!UNIT_EXT.has(ext)) continue;
    const raw = read(rel);
    if (raw == null) continue;
    const text = raw.replace(/\r\n/g, '\n');
    let imports = [];
    if (ext === 'py') imports = pyImports(text);
    else if (ext === 'go') imports = goImports(text);
    else if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'html'].includes(ext)) imports = jsImports(text, ext);
    files.push({ path: rel, lang, lines: countLines(text), isTest: TEST_RE.test(rel), doc: firstDoc(text, ext), symbols: symbolsOf(text, ext), imports, _text: text });
  }
  const fileSet = new Set(files.map((f) => f.path));

  // ---- import resolution ----
  const resolveJs = (from, spec) => {
    let base;
    if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), spec));
    else if (spec.startsWith('/')) base = spec.slice(1);
    else if ((spec.startsWith('@/') || spec.startsWith('~/')) && allSet.has('src') === false && files.some((f) => f.path.startsWith('src/'))) base = 'src/' + spec.slice(2);
    else return null;
    const cands = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
    const swap = base.replace(/\.(m?js|cjs)$/, '');
    if (swap !== base) cands.push(...['.ts', '.tsx', '.jsx'].map((e) => swap + e));
    return cands.find((c) => fileSet.has(c)) || null;
  };
  const pyModuleFile = (cands) => cands.find((c) => fileSet.has(c)) || null;
  const resolvePy = (from, imp) => {
    const dir = posix.dirname(from);
    const spec = imp.spec;
    const dots = (spec.match(/^\.+/) || [''])[0].length;
    const rest = spec.slice(dots).split('.').filter(Boolean);
    // Python 3: absolute imports resolve from the project root (or src/). A script's own directory is also on sys.path,
    // but inside a package (a folder with __init__.py) a bare "import b" never means the sibling pkg/b.py.
    const inPackage = allSet.has(posix.join(dir, '__init__.py'));
    const roots = dots ? [posix.join(dir, ...Array(dots - 1).fill('..'))] : ['', 'src', ...(inPackage ? [] : [dir])];
    for (const r of roots) {
      const b = posix.join(r, ...rest);
      const sub = imp.names.map((n) => [`${b}/${n}.py`, `${b}/${n}/__init__.py`]).flat();
      const hit = pyModuleFile([...sub, `${b}.py`, `${b}/__init__.py`]);
      if (hit && hit !== from) return hit;
    }
    return null;
  };
  const goDirs = new Map();
  for (const f of files.filter((f) => f.path.endsWith('.go') && !f.isTest)) {
    const d = posix.dirname(f.path);
    if (!goDirs.has(d)) goDirs.set(d, f.path);
  }

  const externals = {};
  const noteExternal = (name, file, line) => {
    const e = (externals[name] ||= { name, version: versions[name] || null, files: [], firstRef: { path: file, line } });
    if (!e.files.includes(file)) e.files.push(file);
  };
  const npmName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

  for (const f of files) {
    const ext = extOf(f.path);
    for (const imp of f.imports) {
      let resolved = null;
      if (ext === 'py') {
        resolved = resolvePy(f.path, imp);
        if (!resolved) {
          const top = imp.spec.split('.')[0].toLowerCase();
          if (top && depNames.has(top)) noteExternal(top, f.path, imp.line);
        }
      } else if (ext === 'go') {
        if (goModule && imp.spec.startsWith(goModule)) {
          const d = imp.spec.slice(goModule.length).replace(/^\//, '');
          resolved = goDirs.get(d || '.') || null;
        } else {
          const dep = [...depNames].find((d) => imp.spec === d || imp.spec.startsWith(d + '/'));
          if (dep) noteExternal(dep, f.path, imp.line);
        }
      } else {
        resolved = resolveJs(f.path, imp.spec);
        if (!resolved && !imp.spec.startsWith('.') && !imp.spec.startsWith('/')) {
          const n = npmName(imp.spec);
          if (depNames.has(n)) noteExternal(n, f.path, imp.line);
        }
      }
      imp.resolved = resolved;
      imp.spec = String(imp.spec);
      delete imp.py; delete imp.go;
    }
  }

  // ---- entry points ----
  const entryPoints = [];
  const addEntry = (p, reason) => {
    if (p && fileSet.has(p) && !entryPoints.some((e) => e.path === p)) entryPoints.push({ path: p, reason });
  };
  const rootPkg = manifests.find((m) => m.type === 'npm' && !m.file.includes('/'));
  if (rootPkg) {
    if (rootPkg.main) addEntry(posix.normalize(rootPkg.main.replace(/^\.\//, '')), `package.json "main"`);
    const bins = typeof rootPkg.bin === 'string' ? [rootPkg.bin] : Object.values(rootPkg.bin || {});
    bins.forEach((b) => addEntry(posix.normalize(String(b).replace(/^\.\//, '')), 'package.json "bin"'));
    for (const key of ['start', 'dev', 'serve']) {
      const cmd = rootPkg.scripts[key];
      const m = cmd && cmd.match(/(?:node|nodemon|tsx|ts-node|bun)\s+(?:--\S+\s+)*([\w./-]+\.(?:m?js|cjs|ts))/);
      if (m) addEntry(posix.normalize(m[1].replace(/^\.\//, '')), `package.json script "${key}"`);
    }
  }
  for (const f of files.filter((x) => x.path.endsWith('.html') && !x.path.includes('/'))) {
    for (const imp of f.imports) if (imp.resolved) addEntry(imp.resolved, `loaded by ${f.path} <script>`);
    if (f.imports.some((i) => i.resolved)) addEntry(f.path, 'HTML entry page');
  }
  const conventional = /(^|\/)(main|index|app|server|cli|__main__|manage|wsgi|asgi)\.(m?js|cjs|jsx|ts|tsx|py|go|rs|java)$/;
  files.filter((f) => !f.isTest && f.path.split('/').length <= 3 && conventional.test(f.path)).forEach((f) => addEntry(f.path, 'conventional entry filename'));
  files.filter((f) => f.path.endsWith('.go') && /^package main\b/m.test(f._text)).forEach((f) => addEntry(f.path, 'Go package main'));
  if (!entryPoints.length) {
    // Libraries have no main(): use the package's public entry (shallowest __init__.py, most imports).
    const init = files
      .filter((f) => /(^|\/)__init__\.py$/.test(f.path) && !f.isTest)
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || b.imports.length - a.imports.length)[0];
    if (init) addEntry(init.path, 'Python package __init__.py (public API)');
  }

  // ---- routes & api calls ----
  const routes = [];
  const apiCalls = [];
  // Routes are only reported for files that import a real server framework, so client-side calls
  // like `api.get('/x')` on an axios instance are never mistaken for server routes.
  const SERVER_JS = /^(express|fastify|koa|koa-router|@koa\/router|hono|restify|@hapi\/hapi|@nestjs\/common)$/;
  const SERVER_PY = /^(flask|fastapi|quart|bottle|sanic)\b/;
  for (const f of files) {
    let m;
    const isPy = f.path.endsWith('.py');
    const serverFile = f.imports.some((i) => (isPy ? SERVER_PY.test(i.spec) : SERVER_JS.test(i.spec)));
    if (serverFile && !isPy) {
      const re = /\b(?:app|router|server|api|fastify)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
      while ((m = re.exec(f._text)) && routes.length < 60) routes.push({ method: m[1].toUpperCase(), path: m[2], file: f.path, line: lineAt(f._text, m.index) });
    } else if (serverFile && isPy) {
      const re = /^@\w+\.(route|get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/gm;
      while ((m = re.exec(f._text)) && routes.length < 60) routes.push({ method: m[1] === 'route' ? 'ANY' : m[1].toUpperCase(), path: m[2], file: f.path, line: lineAt(f._text, m.index) });
    }
    const re2 = /\b(?:fetch|axios(?:\.\w+)?|\$http\.\w+)\(\s*['"`]([^'"`]+)['"`]/g;
    while ((m = re2.exec(f._text)) && apiCalls.length < 60) apiCalls.push({ target: m[1], file: f.path, line: lineAt(f._text, m.index) });
  }

  const ext = Object.values(externals).map((e) => ({ ...e, kind: KNOWN_EXTERNAL[e.name] || 'external', declaredAt: depLine[e.name] || null }));
  ext.sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));

  const topDirs = {};
  for (const rel of all) {
    const top = rel.includes('/') ? rel.split('/')[0] : '.';
    topDirs[top] = (topDirs[top] || 0) + 1;
  }

  return {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    root,
    repo,
    readme: readmeSummary(read, all),
    stats: { files: all.length, sourceFiles: files.length, languages: langCount, topDirs },
    manifests,
    entryPoints,
    externals: ext,
    routes,
    apiCalls,
    files: files.map(({ _text, ...rest }) => rest),
  };
}
