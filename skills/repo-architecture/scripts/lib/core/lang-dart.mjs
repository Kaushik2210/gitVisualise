// Dart: `import 'package:my_app/src/foo.dart'` names a package and a path inside its lib/ directory, and relative
// imports are plain paths. pubspec.yaml files give the package names (a monorepo can hold several), so
// `package:` imports of packages in this repository resolve to real files; `dart:` libraries are the SDK and are ignored.
// A package that is declared in pubspec.yaml but lives elsewhere becomes an external node. `part` / `export` count too.
import * as posix from './posix.mjs';

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

export function dartImports(text) {
  const out = [];
  const re = /^[ \t]*(import|export|part)[ \t]+(['"])([^'"\n]+)\2/gm;
  let m;
  while ((m = re.exec(text))) {
    if (m[3].startsWith('dart:')) continue;
    out.push({ spec: m[3], line: lineOf(text, m.index), names: [], _: { kind: m[1] } });
  }
  return out;
}

export function dartSymbols(text) {
  const out = [];
  const re = /^[ \t]*(?:(?:abstract|base|final|sealed|interface|mixin)\s+)*(?:class|mixin|enum|extension\s+type|typedef)\s+([A-Za-z_]\w*)/gm;
  let m;
  while ((m = re.exec(text)) && out.length < 12) if (!out.some((s) => s.name === m[1])) out.push({ name: m[1], line: lineOf(text, m.index) });
  return out;
}

export const hasDartMain = (text) => /^[ \t]*(?:void|Future<void>|FutureOr<void>)\s+main\s*\(/m.test(text);

/** name, dependencies and their lines from a pubspec.yaml (only the few keys we need, so a small line reader suffices). */
export function parsePubspec(text) {
  const lines = text.split('\n');
  const nameLine = lines.findIndex((l) => /^name\s*:/.test(l));
  const name = nameLine >= 0 ? lines[nameLine].replace(/^name\s*:\s*/, '').replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim() : null;
  const deps = [];
  let section = null;
  lines.forEach((l, i) => {
    if (/^\S/.test(l)) { section = /^(dependencies|dev_dependencies)\s*:/.exec(l) ? RegExp.$1 : null; return; }
    if (!section) return;
    const m = /^ {2}([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(l);
    if (m) deps.push({ name: m[1], version: m[2].replace(/\s+#.*$/, '').trim() || null, line: i + 1, dev: section === 'dev_dependencies' });
  });
  return { name, deps };
}

export function buildDartContext(allPaths, read) {
  const packages = new Map(); // package name -> directory ('' for the root)
  const deps = [];
  for (const file of allPaths) {
    if (posix.basename(file) !== 'pubspec.yaml' || file.split('/').length > 5) continue;
    const text = read(file);
    if (!text) continue;
    const p = parsePubspec(text);
    const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    if (p.name) packages.set(p.name, dir);
    for (const d of p.deps) deps.push({ name: d.name, version: d.version, file, line: d.line, dev: d.dev });
  }
  return { packages, deps, set: new Set(allPaths) };
}

export function resolveDartImport(imp, ctx, fromPath) {
  const spec = imp.spec;
  if (spec.startsWith('package:')) {
    const rest = spec.slice('package:'.length);
    const slash = rest.indexOf('/');
    const pkg = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? '' : rest.slice(slash + 1);
    if (ctx.packages.has(pkg)) {
      const dir = ctx.packages.get(pkg);
      const file = posix.normalize(dir ? `${dir}/lib/${path}` : `lib/${path}`);
      return ctx.set.has(file) && file !== fromPath ? { file } : {};
    }
    return ctx.deps.some((d) => d.name === pkg) ? { external: pkg } : {};
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return {}; // any other scheme
  const file = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  return ctx.set.has(file) && file !== fromPath ? { file } : {};
}

export const dart = {
  name: 'dart',
  exts: ['dart'],
  langNames: { dart: 'Dart' },
  packageUnit: false,
  manifests: ['pubspec\\.yaml'],
  parse: (text) => ({ imports: dartImports(text), symbols: dartSymbols(text) }),
  prepare({ allPaths, read }) {
    const ctx = buildDartContext(allPaths, read);
    const runtime = ctx.deps.filter((d) => !d.dev);
    const manifests = [...new Set(ctx.deps.map((d) => d.file))].map((file) => ({ file, type: 'pub', dependencies: ctx.deps.filter((d) => d.file === file && !d.dev).map((d) => d.name) }));
    return { state: ctx, deps: [...runtime, ...ctx.deps.filter((d) => d.dev && !runtime.some((r) => r.name === d.name))], manifests };
  },
  resolve(imp, ctx, file) {
    const r = resolveDartImport(imp, ctx, file.path);
    if (r.file) return { files: [r.file] };
    return r.external ? { external: r.external } : {};
  },
  entry(file) {
    if (!hasDartMain(file._text)) return null;
    return /(^|\/)(lib\/main|bin\/[^/]+)\.dart$/.test(file.path) ? 'Dart main() entry point' : null;
  },
};
