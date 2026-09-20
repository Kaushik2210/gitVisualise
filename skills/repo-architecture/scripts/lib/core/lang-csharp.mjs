// C#: `using` directives name namespaces, not files, so resolution goes through an index of the namespaces and types
// the repository itself declares. A `using Some.Namespace;` links to the files of that namespace only when the importing
// file really mentions one of the types they declare; anything else (the .NET libraries, NuGet packages) is dropped, or
// becomes an external node only when a .csproj declares the package.
import * as posix from './posix.mjs';

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function csharpImports(text) {
  const out = [];
  // `using X;`, `using static X.Y;`, `using A = X.Y;`, `global using X;`. Not `using (var x = ...)` or `using var x = ...;`.
  const re = /^[ \t]*(?:global\s+)?using\s+(?:(static)\s+)?(?:(\w+)\s*=\s*)?([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*)\s*;/gm;
  let m;
  while ((m = re.exec(text))) {
    if (m[3] === 'var') continue;
    out.push({ spec: m[3], line: lineOf(text, m.index), names: m[2] ? [m[2]] : [], _: { isStatic: !!m[1], alias: m[2] || null } });
  }
  return out;
}

const TYPE_RE = /^[ \t]*(?:(?:public|internal|private|protected|static|abstract|sealed|partial|readonly|unsafe|file|ref|new)\s+)*(?:class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)/gm;
const NS_RE = /^[ \t]*namespace\s+([A-Za-z_][\w.]*)\s*(?:;|\{|$)/gm;

export function csharpSymbols(text) {
  const out = [];
  let m;
  TYPE_RE.lastIndex = 0;
  while ((m = TYPE_RE.exec(text)) && out.length < 12) if (!out.some((s) => s.name === m[1])) out.push({ name: m[1], line: lineOf(text, m.index) });
  return out;
}

/** The namespaces and types a file declares. A type belongs to the namespace declared closest above it. */
export function declarations(text) {
  const nss = [];
  let m;
  NS_RE.lastIndex = 0;
  while ((m = NS_RE.exec(text))) nss.push({ name: m[1], at: m.index });
  const types = [];
  TYPE_RE.lastIndex = 0;
  while ((m = TYPE_RE.exec(text))) {
    let ns = '';
    for (const n of nss) if (n.at < m.index) ns = n.name;
    types.push({ ns, name: m[1] });
  }
  return { namespaces: nss.map((n) => n.name), types };
}

export function buildCsharpIndex(files) {
  const typeFiles = new Map(); // "Ns.Type" -> file
  const nsTypes = new Map();   // "Ns" -> Map(file -> [type names])
  for (const f of files) {
    if (!f.path.endsWith('.cs')) continue;
    const d = declarations(f._text || '');
    for (const t of d.types) {
      const fq = t.ns ? `${t.ns}.${t.name}` : t.name;
      if (!typeFiles.has(fq)) typeFiles.set(fq, f.path);
      if (!nsTypes.has(t.ns)) nsTypes.set(t.ns, new Map());
      const byFile = nsTypes.get(t.ns);
      if (!byFile.has(f.path)) byFile.set(f.path, []);
      byFile.get(f.path).push(t.name);
    }
  }
  return { typeFiles, nsTypes };
}

/** Files of a namespace that the importing file actually refers to (by a type name, as a whole word). */
export function resolveCsharpImport(imp, index, file) {
  const spec = imp.spec;
  if (index.typeFiles.has(spec)) return [index.typeFiles.get(spec)].filter((p) => p !== file.path);
  const users = index.nsTypes.get(spec);
  if (!users) return [];
  const text = (file._text || '').replace(/^[ \t]*(?:global\s+)?using\s[^\n]*$/gm, ''); // ignore the using lines themselves
  const hits = [];
  for (const [path, names] of users) {
    if (path === file.path) continue;
    if (names.slice(0, 200).some((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(text))) hits.push(path);
    if (hits.length >= 20) break;
  }
  return hits;
}

/** PackageReference / PackageVersion entries from .csproj, .props and .targets files. */
export function parseNugetDeps(read, allPaths) {
  const deps = [];
  for (const file of allPaths) {
    if (!/\.(csproj|fsproj|vbproj|props|targets)$/i.test(file) || file.split('/').length > 6) continue;
    const text = read(file);
    if (!text) continue;
    const re = /<Package(?:Reference|Version)\b[^>]*?\bInclude\s*=\s*"([^"]+)"([^>]*)>/gi;
    let m;
    while ((m = re.exec(text))) {
      const v = /\bVersion\s*=\s*"([^"]+)"/i.exec(m[0]);
      deps.push({ name: m[1], version: v ? v[1] : null, file, line: lineOf(text, m.index) });
    }
  }
  return deps;
}

export function matchNuget(spec, deps) {
  const s = spec.toLowerCase();
  let best = null;
  for (const d of deps) {
    const n = d.name.toLowerCase();
    if ((s === n || s.startsWith(n + '.')) && (!best || n.length > best.name.length)) best = d;
  }
  return best;
}

export const hasCsharpMain = (text) =>
  /\bstatic\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/.test(text) || /\bWebApplication\s*\.\s*CreateBuilder\s*\(/.test(text) || /\bHost\s*\.\s*CreateDefaultBuilder\s*\(/.test(text);

export const csharp = {
  name: 'csharp',
  exts: ['cs'],
  langNames: { cs: 'C#' },
  packageUnit: true,
  manifests: ['[^/]+\\.(?:cs|fs|vb)proj', 'Directory\\.Packages\\.props'],
  parse: (text) => ({ imports: csharpImports(text), package: (declarations(text).namespaces[0] || ''), symbols: csharpSymbols(text) }),
  prepare({ files, allPaths, read }) {
    const deps = parseNugetDeps(read, allPaths);
    const manifests = [...new Set(deps.map((d) => d.file))].map((file) => ({ file, type: 'nuget', dependencies: deps.filter((d) => d.file === file).map((d) => d.name) }));
    return { state: { index: buildCsharpIndex(files), deps }, deps, manifests };
  },
  resolve(imp, st, file) {
    const hits = resolveCsharpImport(imp, st.index, file);
    if (hits.length) return { files: hits };
    const dep = matchNuget(imp.spec, st.deps);
    return dep ? { external: dep.name } : {};
  },
  entry(file) {
    if (hasCsharpMain(file._text)) return 'C# Main method or ASP.NET / generic host program';
    return posix.basename(file.path) === 'Program.cs' ? 'Program.cs (top-level statements)' : null;
  },
};
