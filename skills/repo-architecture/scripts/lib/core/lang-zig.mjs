// Zig: `@import("x.zig")` is a path relative to the importing file, so it resolves only to a file that exists. `@import("name")` is a
// named module: it resolves to the file `b.addModule("name", ...)` points at in build.zig, or to an external package when
// build.zig.zon declares a dependency of that name. `std`, `builtin` and `root` are the compiler's own and are dropped, never guessed.
import * as posix from './posix.mjs';

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

export function zigImports(text) {
  const out = [];
  const re = /@import\(\s*"([^"\n]+)"\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const start = text.lastIndexOf('\n', m.index) + 1;
    const head = text.slice(start, m.index);
    if (/^\s*(\/\/|\\\\)/.test(head) || /\/\/[^"]*$/.test(head)) continue; // a comment, or a multiline string literal line
    out.push({ spec: m[1], line: lineOf(text, m.index), names: [] });
  }
  return out;
}

/** build.zig.zon -> the dependency names under `.dependencies = .{ ... }`, as { name, line }. */
export function parseZon(text) {
  const out = [];
  const at = text.search(/\.dependencies\s*=\s*\.\{/);
  if (at < 0) return out;
  let depth = 0, i = text.indexOf('{', at), end = text.length;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) { end = j; break; }
  }
  const body = text.slice(i + 1, end);
  // only the entries at the first nesting level of the dependencies block
  let d = 0, buf = '', base = i + 1;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === '{') { if (d === 0) { const m = /\.(?:@"([^"]+)"|([A-Za-z_]\w*))\s*=\s*\.?$/.exec(buf); if (m) out.push({ name: m[1] || m[2], line: lineOf(text, base + j) }); } d++; }
    else if (c === '}') d--;
    if (d === 0) buf = c === '}' ? '' : buf + c;
  }
  return out;
}

/** build.zig -> { module name: root file } for `b.addModule("name", .{ .root_source_file = b.path("src/x.zig") })`. */
export function parseBuildModules(text) {
  const out = new Map();
  const re = /\baddModule\(\s*"([^"]+)"\s*,[\s\S]*?b\.path\(\s*"([^"]+)"\s*\)/g;
  let m;
  while ((m = re.exec(text))) out.set(m[1], m[2]);
  return out;
}

export const hasZigMain = (text) => /^\s*pub\s+fn\s+main\s*\(/m.test(text);

export const zig = {
  name: 'zig',
  exts: ['zig'],
  langNames: { zig: 'Zig' },
  packageUnit: false,
  manifests: ['build\\.zig\\.zon'],
  parse: (text) => ({ imports: zigImports(text) }),
  prepare({ allPaths, read }) {
    const set = new Set(allPaths);
    const deps = [], manifests = [], modules = new Map(), declared = new Set();
    for (const p of allPaths) {
      const base = posix.basename(p);
      if (base === 'build.zig.zon') {
        const found = parseZon(read(p) || '');
        found.forEach((d) => { deps.push({ name: d.name, version: null, file: p, line: d.line }); declared.add(d.name); });
        manifests.push({ file: p, type: 'zon', dependencies: found.map((d) => d.name) });
      } else if (base === 'build.zig') {
        const dir = posix.dirname(p) === '.' ? '' : posix.dirname(p);
        for (const [name, rel] of parseBuildModules(read(p) || '')) modules.set(name, posix.normalize(dir ? `${dir}/${rel}` : rel));
      }
    }
    return { state: { set, modules, declared }, deps, manifests };
  },
  resolve(imp, st, file) {
    const spec = imp.spec;
    if (/\.zig$/.test(spec)) {
      const target = posix.normalize(posix.join(posix.dirname(file.path), spec));
      return st.set.has(target) && target !== file.path ? { files: [target] } : {};
    }
    if (spec === 'std' || spec === 'builtin' || spec === 'root') return {};
    const mod = st.modules.get(spec);
    if (mod && st.set.has(mod) && mod !== file.path) return { files: [mod] };
    return st.declared.has(spec) ? { external: spec } : {};
  },
  entry(file) {
    return hasZigMain(file._text || '') ? 'Zig pub fn main' : null;
  },
};
