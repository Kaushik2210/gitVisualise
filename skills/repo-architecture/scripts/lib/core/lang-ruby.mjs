// Ruby: `require_relative` is a path relative to the file; `require` searches the load path, which we take to be the
// repository's `lib` directories, its root, and `app` / `src` (the usual Bundler and Rails layouts). A `require` that
// finds no file becomes an external node only when the Gemfile or a gemspec declares that gem.
import * as posix from './posix.mjs';

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

export function rubyImports(text) {
  const out = [];
  // require 'x' | require_relative 'x' | load 'x.rb' | autoload :Const, 'x'. Interpolated paths are not static.
  const re = /^[ \t]*(require_relative|require|load|autoload)\b[ \t]*\(?[ \t]*(?::\w+[ \t]*,[ \t]*)?(['"])([^'"\n]+)\2/gm;
  let m;
  while ((m = re.exec(text))) {
    if (m[3].includes('#{')) continue;
    out.push({ spec: m[3], line: lineOf(text, m.index), names: [], _: { relative: m[1] === 'require_relative' || (m[1] === 'load' && /^\.{1,2}\//.test(m[3])) } });
  }
  return out;
}

export function rubySymbols(text) {
  const out = [];
  const re = /^[ \t]*(?:class|module)\s+([A-Z]\w*(?:::[A-Z]\w*)*)/gm;
  let m;
  while ((m = re.exec(text)) && out.length < 12) if (!out.some((s) => s.name === m[1])) out.push({ name: m[1], line: lineOf(text, m.index) });
  return out;
}

/** Gems declared in a Gemfile (`gem 'name'`) or a gemspec (`add_dependency 'name'`), with the line that declares them. */
export function parseGemDeps(read, allPaths) {
  const deps = [];
  for (const file of allPaths) {
    const base = posix.basename(file);
    const isGemfile = base === 'Gemfile' || /^gems\.rb$/.test(base);
    const isSpec = /\.gemspec$/.test(base);
    if ((!isGemfile && !isSpec) || file.split('/').length > 4) continue;
    const text = read(file);
    if (!text) continue;
    const re = isGemfile
      ? /^[ \t]*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm
      : /\.add(?:_runtime|_development)?_dependency\s*\(?\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/g;
    let m;
    while ((m = re.exec(text))) deps.push({ name: m[1], version: m[2] || null, file, line: lineOf(text, m.index) });
  }
  return deps;
}

const withRb = (p) => (p.endsWith('.rb') ? [p] : [p + '.rb']);

export function buildRubyContext(allPaths, read) {
  const rb = allPaths.filter((p) => p.endsWith('.rb'));
  const loadDirs = new Set(['']);
  for (const p of rb) {
    const segs = p.split('/');
    segs.forEach((s, i) => { if (s === 'lib' && i < 4) loadDirs.add(segs.slice(0, i + 1).join('/')); });
  }
  for (const d of ['app', 'src', 'app/models', 'app/lib']) if (allPaths.some((p) => p.startsWith(d + '/'))) loadDirs.add(d);
  return { set: new Set(allPaths), loadDirs: [...loadDirs].sort((a, b) => a.split('/').length - b.split('/').length), deps: parseGemDeps(read, allPaths) };
}

export function resolveRubyImport(imp, ctx, fromPath) {
  const spec = imp.spec;
  const relative = imp._ && imp._.relative;
  const candidates = [];
  if (relative) {
    for (const c of withRb(posix.join(posix.dirname(fromPath), spec))) candidates.push(c);
  } else {
    for (const d of ctx.loadDirs) for (const c of withRb(d ? `${d}/${spec}` : spec)) candidates.push(c);
    // a script that sits next to what it requires (require './helper' style, or `require 'helper'` with "." on the load path)
    for (const c of withRb(posix.join(posix.dirname(fromPath), spec))) candidates.push(c);
  }
  const file = candidates.map((c) => posix.normalize(c)).find((c) => ctx.set.has(c) && c !== fromPath);
  if (file) return { file };
  if (relative) return {};
  // a gem: `require 'rails/all'` -> rails, `require 'aws/s3'` -> aws-s3 (only when declared)
  const first = spec.split('/')[0];
  const dashed = spec.split('/').join('-');
  const dep = ctx.deps.find((d) => d.name === spec || d.name === first || d.name === dashed);
  return dep ? { external: dep.name } : {};
}

export const ruby = {
  name: 'ruby',
  exts: ['rb'],
  langNames: { rb: 'Ruby' },
  packageUnit: false,
  manifests: ['Gemfile', 'gems\\.rb', '[^/]+\\.gemspec'],
  parse: (text) => ({ imports: rubyImports(text), symbols: rubySymbols(text) }),
  prepare({ allPaths, read }) {
    const ctx = buildRubyContext(allPaths, read);
    const manifests = [...new Set(ctx.deps.map((d) => d.file))].map((file) => ({ file, type: 'bundler', dependencies: ctx.deps.filter((d) => d.file === file).map((d) => d.name) }));
    return { state: ctx, deps: ctx.deps, manifests };
  },
  resolve(imp, ctx, file) {
    const r = resolveRubyImport(imp, ctx, file.path);
    if (r.file) return { files: [r.file] };
    return r.external ? { external: r.external } : {};
  },
  entry(file) {
    if (/^#!.*\bruby\b/.test(file._text) && /(^|\/)(bin|exe|script)\//.test(file.path)) return 'Ruby executable script';
    if (/^\s*if\s+__FILE__\s*==\s*\$(?:0|PROGRAM_NAME)\b/m.test(file._text)) return 'Ruby script with a main guard';
    return null;
  },
};
