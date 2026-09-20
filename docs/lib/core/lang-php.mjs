// PHP: `use Vendor\Package\Class;` names a class by namespace. It resolves through the classes the repository itself
// declares (namespace + class name) and through the PSR-4 autoload map in composer.json. `require` / `include` with a
// literal path resolve as files. A namespace that belongs to a Composer package becomes an external node only when its
// first segment equals the package's vendor or name exactly (Monolog\Logger -> monolog/monolog); nothing is guessed.
import * as posix from './posix.mjs';

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const clean = (s) => s.replace(/^\\+/, '');

export function phpImports(text) {
  const out = [];
  let m;
  // Group use: use A\B\{C, D as E, function f};
  const group = /^use\s+(?:function\s+|const\s+)?([\\\w]+)\\\{([^}]*)\}\s*;/gm;
  const grouped = new Set();
  while ((m = group.exec(text))) {
    grouped.add(m.index);
    const base = clean(m[1]);
    for (const part of m[2].split(',')) {
      const name = part.trim().replace(/^(?:function|const)\s+/, '').replace(/\s+as\s+\w+$/i, '');
      if (name) out.push({ spec: `${base}\\${name}`, line: lineOf(text, m.index), names: [], _: {} });
    }
  }
  // Plain use at the start of a line (not a closure's `use ($x)`, and not a trait `use` inside a class body, which is indented)
  const plain = /^use\s+(?:function\s+|const\s+)?([\\\w]+?)(?:\s+as\s+\w+)?\s*;/gm;
  while ((m = plain.exec(text))) if (!grouped.has(m.index) && !/\\\{/.test(m[0])) out.push({ spec: clean(m[1]), line: lineOf(text, m.index), names: [], _: {} });
  // require / include with a literal path (optionally __DIR__ . '/x.php')
  const req = /^[ \t]*(?:return\s+)?(?:require|include)(?:_once)?\s*\(?\s*(__DIR__\s*\.\s*)?(['"])([^'"\n]+)\2/gm;
  while ((m = req.exec(text))) out.push({ spec: m[3], line: lineOf(text, m.index), names: [], _: { file: true, fromDir: !!m[1] } });
  return out;
}

export function phpPackage(text) {
  const m = /^\s*namespace\s+([\\\w]+)\s*[;{]/m.exec(text);
  return m ? m[1] : '';
}

const TYPE_RE = /^[ \t]*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(\w+)/gm;
export function phpSymbols(text) {
  const out = [];
  let m;
  TYPE_RE.lastIndex = 0;
  while ((m = TYPE_RE.exec(text)) && out.length < 12) if (!out.some((s) => s.name === m[1])) out.push({ name: m[1], line: lineOf(text, m.index) });
  return out;
}

/** PSR-4 prefixes and Composer dependencies from every composer.json (not inside vendor/). */
export function parseComposer(read, allPaths) {
  const psr4 = []; // { prefix: 'App\\', dir: 'src' } (dir relative to the repository root)
  const deps = [];
  for (const file of allPaths) {
    if (posix.basename(file) !== 'composer.json' || file.split('/').length > 4 || /(^|\/)vendor\//.test(file)) continue;
    const text = read(file);
    if (!text) continue;
    let json;
    try { json = JSON.parse(text); } catch { continue; }
    const base = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    for (const key of ['autoload', 'autoload-dev']) {
      const map = (json[key] && json[key]['psr-4']) || {};
      for (const [prefix, dirs] of Object.entries(map)) {
        for (const d of Array.isArray(dirs) ? dirs : [dirs]) psr4.push({ prefix: prefix.replace(/\\+$/, ''), dir: posix.join(base, d).replace(/^\.$/, '') });
      }
    }
    for (const key of ['require', 'require-dev']) {
      for (const [name, version] of Object.entries(json[key] || {})) {
        if (name === 'php' || name.startsWith('ext-') || name.startsWith('lib-') || !name.includes('/')) continue;
        const line = text.split('\n').findIndex((l) => l.includes(`"${name}"`)) + 1 || 1;
        deps.push({ name, version: String(version), file, line });
      }
    }
  }
  psr4.sort((a, b) => b.prefix.length - a.prefix.length);
  return { psr4, deps };
}

export function buildPhpIndex(files) {
  const classes = new Map(); // "Ns\Class" -> file
  for (const f of files) {
    if (!f.path.endsWith('.php')) continue;
    const ns = f.package || '';
    TYPE_RE.lastIndex = 0;
    let m;
    while ((m = TYPE_RE.exec(f._text || ''))) {
      const fq = ns ? `${ns}\\${m[1]}` : m[1];
      if (!classes.has(fq)) classes.set(fq, f.path);
    }
  }
  return classes;
}

export function resolvePhpImport(imp, st, file, allSet) {
  if (imp._ && imp._.file) {
    const spec = imp._.fromDir ? imp.spec.replace(/^\//, '') : imp.spec;
    const tries = [posix.join(posix.dirname(file.path), spec), spec.replace(/^\.?\//, '')];
    const hit = tries.map((t) => posix.normalize(t)).find((t) => allSet.has(t) && t !== file.path);
    return hit ? { files: [hit] } : {};
  }
  const fq = clean(imp.spec);
  if (st.classes.has(fq)) return { files: [st.classes.get(fq)] };
  for (const { prefix, dir } of st.psr4) {
    if (fq === prefix || !fq.startsWith(prefix + '\\')) continue;
    const rel = fq.slice(prefix.length + 1).split('\\').join('/') + '.php';
    const path = posix.normalize(dir ? `${dir}/${rel}` : rel);
    if (allSet.has(path)) return { files: [path] };
  }
  const seg = fq.split('\\')[0].toLowerCase();
  const dep = st.deps.find((d) => { const [vendor, pkg] = d.name.split('/'); return seg === vendor.toLowerCase() || seg === pkg.toLowerCase(); });
  return dep ? { external: dep.name } : {};
}

export const php = {
  name: 'php',
  exts: ['php'],
  langNames: { php: 'PHP' },
  packageUnit: true,
  manifests: ['composer\\.json'],
  parse: (text) => ({ imports: phpImports(text), package: phpPackage(text), symbols: phpSymbols(text) }),
  prepare({ files, allPaths, read }) {
    const { psr4, deps } = parseComposer(read, allPaths);
    const manifests = [...new Set(deps.map((d) => d.file))].map((file) => ({ file, type: 'composer', dependencies: deps.filter((d) => d.file === file).map((d) => d.name) }));
    return { state: { classes: buildPhpIndex(files), psr4, deps, all: new Set(allPaths) }, deps, manifests };
  },
  resolve: (imp, st, file) => resolvePhpImport(imp, st, file, st.all),
  entry(file) {
    return posix.basename(file.path) === 'index.php' && file.path.split('/').length <= 3 ? 'PHP front controller (index.php)' : null;
  },
};
