// Deterministic repository scanner core. Produces *facts* (files, imports, entry points, dependencies)
// that both the heuristic generator and Claude use, so architecture is grounded in the repo.
// Pure: works on a list of paths plus a read() callback, so it runs unchanged in Node and in the browser.
import { extractApiCalls, usesHttpClient } from './http-core.mjs';
import * as posix from './posix.mjs';
import { countLines } from './text.mjs';
import { PLUGINS, PLUGIN_BY_EXT, PLUGIN_LANG_NAMES } from './languages.mjs';
import { extractInfra } from './infra-core.mjs';
import { extractDataModel } from './data-core.mjs';

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
  ...PLUGIN_LANG_NAMES,
};
// Files that become diagram units.
export const UNIT_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs', 'html', ...Object.keys(PLUGIN_BY_EXT)]);
const JS_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.json'];
export const TEST_RE = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)(-d)?\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$|(^|\/)[^/]*\.tests?(\/|$)|_(test|spec)\.(rb|dart|cc|cpp)$/i;

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

/** Parses JSON with comments and trailing commas (tsconfig.json allows both). Returns null when it cannot be parsed. */
export function parseJsonc(text) {
  let out = '', i = 0, inStr = false, esc = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; }
    else { out += c; i++; }
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

export const extOf =(p) => (p.includes('.') ? p.split('.').pop().toLowerCase() : '');

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
  } else if (ext === 'rs') {
    re = /^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)/gm;
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
  // package.json files up to five levels deep, so workspace packages such as packages/@scope/name are found.
  for (const file of all.filter((f) => /(^|\/)package\.json$/.test(f) && f.split('/').length <= 5)) {
    let pkg;
    try { pkg = JSON.parse(read(file)); } catch { continue; }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    Object.keys(deps).forEach((d) => {
      depNames.add(d);
      versions[d] = deps[d];
      if (!depLine[d]) depLine[d] = { file, line: findLine(file, d) };
    });
    manifests.push({ file, type: 'npm', name: pkg.name || null, description: pkg.description || null, main: pkg.main || pkg.module || null, bin: pkg.bin || null, scripts: pkg.scripts || {}, workspaces: Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces && pkg.workspaces.packages) || [], dependencies: Object.keys(pkg.dependencies || {}), devDependencies: Object.keys(pkg.devDependencies || {}) });
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
export function scanCore({ paths, read, repo, root = '', subPath = '' }) {
  const all = paths;
  const allSet = new Set(all);
  // When analysing one folder of a larger repository, "the project root" (its package.json, index.html, main files)
  // is that folder; every path in the output stays relative to the repository root.
  const base = subPath ? subPath.replace(/^\/+|\/+$/g, '') + '/' : '';
  const inBase = (p) => !base || p.startsWith(base);
  const relBase = (p) => (base ? p.slice(base.length) : p);

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
    const plugin = PLUGIN_BY_EXT[ext];
    const parsed = plugin ? plugin.parse(text, ext) : null;
    let imports = [];
    if (parsed) imports = parsed.imports;
    else if (ext === 'py') imports = pyImports(text);
    else if (ext === 'go') imports = goImports(text);
    else if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'html'].includes(ext)) imports = jsImports(text, ext);
    files.push({ path: rel, lang, lines: countLines(text), isTest: TEST_RE.test(rel), doc: firstDoc(text, ext), symbols: parsed && parsed.symbols ? parsed.symbols : symbolsOf(text, ext), imports, ...(parsed && parsed.package !== undefined ? { package: parsed.package } : {}), _text: text });
  }
  const fileSet = new Set(files.map((f) => f.path));

  // ---- import resolution ----
  // ---- workspaces (monorepos): npm/yarn/pnpm packages and Go modules here; Cargo crates are added below ----
  const workspaces = [];
  {
    const globRe = (g) => new RegExp('^' + g.replace(/^\.\//, '').replace(/\/+$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '@@GLOBSTAR@@').replace(/\*/g, '[^/]+').replace(/@@GLOBSTAR@@/g, '.*') + '$');
    const patterns = manifests.filter((m) => m.type === 'npm' && m.file === 'package.json').flatMap((m) => m.workspaces || []);
    const pnpm = read('pnpm-workspace.yaml');
    if (pnpm) for (const m of pnpm.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/gm)) patterns.push(m[1]);
    const include = patterns.filter((p) => typeof p === 'string' && !p.startsWith('!')).map(globRe);
    if (include.length) {
      for (const m of manifests.filter((x) => x.type === 'npm' && x.file !== 'package.json')) {
        const dir = posix.dirname(m.file);
        if (include.some((re) => re.test(dir))) workspaces.push({ name: m.name || dir, dir, kind: 'npm', manifest: m.file });
      }
    }
    const gowork = read('go.work');
    if (gowork) {
      const dirs = [...gowork.matchAll(/^\s*(?:use\s+)?(\.{1,2}\/[^\s)]+|\.)\s*$/gm)].map((m) => posix.normalize(m[1]));
      for (const dir of dirs) {
        const mod = /^module\s+(\S+)/m.exec(read(dir === '.' ? 'go.mod' : `${dir}/go.mod`) || '');
        if (mod && dir !== '.') workspaces.push({ name: mod[1], dir, kind: 'go' });
      }
    }
  }
  const npmWorkspace = (spec) => workspaces.find((w) => w.kind === 'npm' && (spec === w.name || spec.startsWith(w.name + '/')));

  // ---- JS/TS path aliases: tsconfig/jsconfig "paths" + "baseUrl" (with "extends"), and simple Vite/webpack aliases ----
  const nearestFile = (from, names) => {
    for (let dir = posix.dirname(from); ; dir = posix.dirname(dir)) {
      for (const n of names) {
        const p = dir === '.' ? n : `${dir}/${n}`;
        if (allSet.has(p)) return p;
      }
      if (dir === '.' || dir === '/') return null;
    }
  };
  const tsCache = new Map();
  const loadTsConfig = (file, seen = new Set()) => {
    if (tsCache.has(file)) return tsCache.get(file);
    if (seen.has(file)) return null;
    seen.add(file);
    const j = parseJsonc(read(file) || '');
    let cfg = null;
    if (j && typeof j === 'object') {
      const dir = posix.dirname(file);
      cfg = { baseUrl: null, paths: null, pathsDir: null };
      if (typeof j.extends === 'string' && j.extends.startsWith('.')) {
        const parent = loadTsConfig(posix.normalize(posix.join(dir, /\.json$/.test(j.extends) ? j.extends : j.extends + '.json')), seen);
        if (parent) cfg = { ...parent };
      }
      const co = j.compilerOptions || {};
      if (typeof co.baseUrl === 'string') cfg.baseUrl = posix.normalize(posix.join(dir, co.baseUrl));
      if (co.paths && typeof co.paths === 'object') { cfg.paths = co.paths; cfg.pathsDir = cfg.baseUrl || dir; } // paths are relative to baseUrl, else to the config
    }
    tsCache.set(file, cfg);
    return cfg;
  };
  const bundlerCache = new Map();
  const loadBundlerAliases = (file) => {
    if (bundlerCache.has(file)) return bundlerCache.get(file);
    const txt = read(file) || '';
    const dir = posix.dirname(file);
    const rules = [];
    const target = (raw) => {
      const m = /path\.(?:resolve|join)\(\s*(?:__dirname|process\.cwd\(\))\s*,\s*['"]([^'"]+)['"]\s*\)/.exec(raw) || /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/.exec(raw) || /^\s*['"]([^'"]+)['"]\s*$/.exec(raw);
      return m ? posix.normalize(posix.join(dir, m[1].replace(/^\//, ''))) : null;
    };
    const obj = /alias\s*:\s*\{([\s\S]*?)\n?\s*\}/.exec(txt);
    if (obj) {
      for (const m of obj[1].matchAll(/['"]?([@~\w$/.-]+)['"]?\s*:\s*(path\.(?:resolve|join)\([^)]*\)|fileURLToPath\(\s*new URL\([^)]*\)\s*\)|['"][^'"]+['"])/g)) {
        const t = target(m[2]);
        if (t) rules.push({ key: m[1], dir: t });
      }
    }
    for (const m of txt.matchAll(/find\s*:\s*['"]([^'"]+)['"]\s*,\s*replacement\s*:\s*([^}]+)/g)) { const t = target(m[2].trim().replace(/,\s*$/, '')); if (t) rules.push({ key: m[1], dir: t }); }
    bundlerCache.set(file, rules);
    return rules;
  };
  /** Candidate base paths (no extension yet) for a non-relative import specifier. */
  const aliasBases = (from, spec) => {
    const out = [];
    const tsFile = nearestFile(from, ['tsconfig.json', 'jsconfig.json']);
    const cfg = tsFile && loadTsConfig(tsFile);
    if (cfg && cfg.paths) {
      let best = null;
      for (const [pattern, targets] of Object.entries(cfg.paths)) {
        const star = pattern.indexOf('*');
        if (star < 0 ? pattern === spec : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1) {
          const len = star < 0 ? Infinity : star; // TypeScript prefers the longest matching prefix
          if (!best || len > best.len) best = { len, targets, mid: star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1)) };
        }
      }
      if (best) for (const t of [].concat(best.targets)) out.push(posix.normalize(posix.join(cfg.pathsDir, String(t).replace('*', best.mid))));
    }
    if (cfg && cfg.baseUrl) out.push(posix.normalize(posix.join(cfg.baseUrl, spec)));
    const bundler = nearestFile(from, ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts', 'webpack.config.js', 'webpack.config.cjs', 'webpack.config.mjs', 'webpack.config.ts']);
    if (bundler) for (const r of loadBundlerAliases(bundler)) if (spec === r.key || spec.startsWith(r.key + '/')) out.push(posix.normalize(posix.join(r.dir, spec.slice(r.key.length))));
    return out;
  };
  const tryBase = (base) => {
    const cands = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
    const swap = base.replace(/\.(m?js|cjs)$/, '');
    if (swap !== base) cands.push(...['.ts', '.tsx', '.jsx'].map((e) => swap + e));
    return cands.find((c) => fileSet.has(c)) || null;
  };
  const resolveJs = (from, spec) => {
    if (spec.startsWith('.')) return tryBase(posix.normalize(posix.join(posix.dirname(from), spec)));
    if (spec.startsWith('/')) return tryBase(spec.slice(1));
    for (const b of aliasBases(from, spec)) { const hit = tryBase(b); if (hit) return hit; }
    const ws = npmWorkspace(spec); // a sibling package in the same monorepo, imported by its package name
    if (ws) {
      const sub = spec.slice(ws.name.length + 1);
      const main = (manifests.find((m) => m.file === ws.manifest) || {}).main;
      const cands = sub ? [`${ws.dir}/${sub}`, `${ws.dir}/src/${sub}`] : [...(main ? [`${ws.dir}/${main.replace(/^\.\//, '')}`] : []), `${ws.dir}/src/index`, `${ws.dir}/index`];
      for (const c of cands) { const hit = tryBase(posix.normalize(c)); if (hit) return hit; }
      return null;
    }
    if ((spec.startsWith('@/') || spec.startsWith('~/')) && files.some((f) => f.path.startsWith('src/'))) return tryBase('src/' + spec.slice(2)); // common convention when no config was found
    return null;
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

  // Language plug-ins: each builds its index once (types, crates, packages ...) and reports the dependencies it found.
  const langState = new Map();
  const pluginWorkspaces = [];
  for (const pl of PLUGINS) {
    if (!files.some((f) => PLUGIN_BY_EXT[extOf(f.path)] === pl) && !pl.alwaysPrepare) { langState.set(pl.name, null); continue; }
    const p = pl.prepare({ files, allPaths: all, read }) || {};
    langState.set(pl.name, p.state);
    for (const d of p.deps || []) { if (d.version) versions[d.name] = d.version; if (!depLine[d.name]) depLine[d.name] = { file: d.file, line: d.line }; }
    manifests.push(...(p.manifests || []));
    pluginWorkspaces.push(...(p.workspaces || []));
  }

  const externals = {};
  const noteExternal = (name, file, line) => {
    const e = (externals[name] ||= { name, version: versions[name] || null, files: [], firstRef: { path: file, line } });
    if (!e.files.includes(file)) e.files.push(file);
  };
  const npmName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

  for (const f of files) {
    const ext = extOf(f.path);
    const extraImports = []; // a package wildcard import resolves to several files
    for (const imp of f.imports) {
      let resolved = null;
      if (ext === 'py') {
        resolved = resolvePy(f.path, imp);
        if (!resolved) {
          const top = imp.spec.split('.')[0].toLowerCase();
          if (top && depNames.has(top)) noteExternal(top, f.path, imp.line);
        }
      } else if (PLUGIN_BY_EXT[ext]) {
        const pl = PLUGIN_BY_EXT[ext];
        const r = pl.resolve(imp, langState.get(pl.name), f) || {};
        const hits = (r.files || []).filter((p) => fileSet.has(p));
        if (hits.length) {
          resolved = hits[0];
          // a package or wildcard import can resolve to several files
          extraImports.push(...hits.slice(1).map((p) => ({ spec: imp.spec, line: imp.line, names: [], resolved: p })));
        } else if (r.external) noteExternal(r.external, f.path, imp.line);
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
      delete imp.py; delete imp.go; delete imp.java; delete imp.rust; delete imp._;
    }
    f.imports.push(...extraImports);
  }

  // ---- entry points ----
  const entryPoints = [];
  const addEntry = (p, reason) => {
    if (p && fileSet.has(p) && !entryPoints.some((e) => e.path === p)) entryPoints.push({ path: p, reason });
  };
  const rootPkg = manifests.find((m) => m.type === 'npm' && m.file === base + 'package.json');
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
  for (const f of files.filter((x) => x.path.endsWith('.html') && inBase(x.path) && !relBase(x.path).includes('/'))) {
    for (const imp of f.imports) if (imp.resolved) addEntry(imp.resolved, `loaded by ${f.path} <script>`);
    if (f.imports.some((i) => i.resolved)) addEntry(f.path, 'HTML entry page');
  }
  const conventional = /(^|\/)(main|index|app|server|cli|__main__|manage|wsgi|asgi)\.(m?js|cjs|jsx|ts|tsx|py|go|rs|java|kt|rb|php|cs|dart|c|cc|cpp)$/;
  files.filter((f) => !f.isTest && inBase(f.path) && relBase(f.path).split('/').length <= 3 && conventional.test(f.path)).forEach((f) => addEntry(f.path, 'conventional entry filename'));
  files.filter((f) => f.path.endsWith('.go') && /^package main\b/m.test(f._text)).forEach((f) => addEntry(f.path, 'Go package main'));
  for (const pl of PLUGINS) {
    if (!pl.entry || langState.get(pl.name) === null) continue; // null: no file of this language in the scan
    for (const f of files) if (PLUGIN_BY_EXT[extOf(f.path)] === pl && !f.isTest) { const why = pl.entry(f, langState.get(pl.name)); if (why) addEntry(f.path, why); }
  }
  if (!entryPoints.length) {
    // Libraries have no main(): use the package's public entry (shallowest __init__.py, most imports).
    const init = files
      .filter((f) => /(^|\/)__init__\.py$/.test(f.path) && !f.isTest)
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || b.imports.length - a.imports.length)[0];
    if (init) addEntry(init.path, 'Python package __init__.py (public API)');
  }
  if (!entryPoints.length) {
    for (const pl of PLUGINS) for (const e of (pl.entryFallback ? pl.entryFallback(files, langState.get(pl.name)) : [])) addEntry(e.path, e.reason);
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
      // router.route('/x').get(a).post(b): one path, several verbs.
      const chain = /\b(?:app|router|server|api)\.route\(\s*['"`]([^'"`]+)['"`]\s*\)((?:\s*\.(?:get|post|put|delete|patch)\([^)]*\))+)/g;
      while ((m = chain.exec(f._text)) && routes.length < 60) {
        for (const v of m[2].matchAll(/\.(get|post|put|delete|patch)\(/g)) routes.push({ method: v[1].toUpperCase(), path: m[1], file: f.path, line: lineAt(f._text, m.index) });
      }
    } else if (serverFile && isPy) {
      const re = /^@\w+\.(route|get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]([^\n]*)/gm;
      while ((m = re.exec(f._text)) && routes.length < 60) {
        // Flask: @app.route('/x', methods=['POST', 'PUT']) declares its verbs in the decorator arguments.
        const verbs = m[1] === 'route' ? ((/methods\s*=\s*[\[(]([^\])]*)/.exec(m[3]) || [])[1] || '').match(/[A-Za-z]+/g) : null;
        for (const method of verbs && verbs.length ? verbs : [m[1] === 'route' ? 'ANY' : m[1]]) routes.push({ method: method.toUpperCase(), path: m[2], file: f.path, line: lineAt(f._text, m.index) });
      }
    }
    const clientFile = usesHttpClient(f.imports);
    for (const c of extractApiCalls(f._text, { serverFile, clientFile }, lineAt, 60 - apiCalls.length)) apiCalls.push({ ...c, file: f.path });
  }

  // Express-style mounting: `app.use('/api/items', itemRouter)` puts every route of the router file that
  // `itemRouter` was imported from under that prefix. Only unambiguous mounts (one prefix per file) are applied.
  const mounts = new Map();
  for (const f of files) {
    if (f.path.endsWith('.py') || !f.imports.some((i) => SERVER_JS.test(i.spec))) continue;
    const use = /\.use\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*(?:[\w$.()]+\s*,\s*)*([A-Za-z_$][\w$]*)\s*\)/g;
    let m;
    while ((m = use.exec(f._text))) {
      const id = m[2].replace(/[$]/g, '\\$&');
      const bind = new RegExp('import\\s+' + id + '\\s+from\\s+[\'"]([^\'"]+)[\'"]|\\b' + id + '\\s*=\\s*require\\(\\s*[\'"]([^\'"]+)[\'"]\\s*\\)').exec(f._text);
      const spec = bind && (bind[1] || bind[2]);
      const target = spec && f.imports.find((i) => i.spec === spec)?.resolved;
      if (!target || target === f.path) continue;
      mounts.set(target, mounts.has(target) && mounts.get(target) !== m[1] ? null : m[1]);
    }
  }
  for (const r of routes) {
    const prefix = mounts.get(r.file);
    if (prefix) r.path = (prefix.replace(/\/+$/, '') + '/' + r.path.replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
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
    subPath: subPath ? subPath.replace(/^\/+|\/+$/g, '') : null,
    repo,
    readme: readmeSummary(read, all),
    stats: { files: all.length, sourceFiles: files.length, languages: langCount, topDirs },
    manifests,
    workspaces: (() => {
      for (const w of pluginWorkspaces) if (!workspaces.some((x) => x.dir === w.dir)) workspaces.push(w);
      return workspaces.length >= 2 ? workspaces.map(({ name, dir, kind }) => ({ name, dir, kind })).sort((a, b) => a.dir.localeCompare(b.dir)) : [];
    })(),
    entryPoints,
    // Two extra views that are not import graphs: services in Docker Compose files, and tables / models in SQL and Prisma schemas.
    infra: extractInfra(all.filter(inBase), read),
    dataModel: extractDataModel(all.filter(inBase), read),
    externals: ext,
    routes,
    apiCalls,
    files: files.map(({ _text, ...rest }) => rest),
  };
}
