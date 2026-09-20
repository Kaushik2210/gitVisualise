// C and C++: `#include "local.h"` is a path, searched relative to the including file, then in the project's include
// directories (from CMake's include_directories / target_include_directories, `-I` flags in Makefiles, and the
// conventional include/ and src/). `#include <system.h>` is only followed when a project include directory really
// contains that header; otherwise it is a system or third-party header and is dropped. No file is ever guessed.
import * as posix from './posix.mjs';

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

export function cImports(text) {
  const out = [];
  const re = /^[ \t]*#[ \t]*(?:include|import)[ \t]*(?:"([^"\n]+)"|<([^>\n]+)>)/gm;
  let m;
  while ((m = re.exec(text))) out.push({ spec: m[1] || m[2], line: lineOf(text, m.index), names: [], _: { angle: !m[1] } });
  return out;
}

export function cSymbols(text) {
  const out = [];
  const re = /^[ \t]*(?:typedef\s+)?(?:struct|class|enum(?:\s+class)?|union|namespace)\s+(\w+)\s*(?:[:{]|$)/gm;
  let m;
  while ((m = re.exec(text)) && out.length < 12) if (!out.some((s) => s.name === m[1])) out.push({ name: m[1], line: lineOf(text, m.index) });
  return out;
}

export const hasCMain = (text) => /^[ \t]*(?:int|auto)\s+(?:w?main|WinMain)\s*\(/m.test(text);

/** Include directories declared by build files, as repository-relative paths (existing directories only). */
export function includeDirs(allPaths, read) {
  const dirsWithFiles = new Set();
  for (const p of allPaths) { const segs = p.split('/'); for (let i = 1; i < segs.length; i++) dirsWithFiles.add(segs.slice(0, i).join('/')); }
  const found = new Set(['']);
  const add = (d) => { const n = posix.normalize(d); const key = n === '.' ? '' : n; if (key === '' || dirsWithFiles.has(key)) found.add(key); };
  for (const d of ['include', 'inc', 'src', 'lib', 'source']) add(d);
  for (const file of allPaths) {
    const base = posix.basename(file);
    if (file.split('/').length > 4) continue;
    const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    const isCmake = base === 'CMakeLists.txt' || /\.cmake$/.test(base);
    const isMake = base === 'Makefile' || /\.(mk|am)$/.test(base) || base === 'meson.build';
    if (!isCmake && !isMake) continue;
    const text = read(file);
    if (!text) continue;
    for (const d of ['include', 'inc', 'src']) add(dir ? `${dir}/${d}` : d);
    add(dir);
    if (isCmake) {
      const re = /\b(?:target_)?include_directories\s*\(([^)]*)\)/gi;
      let m;
      while ((m = re.exec(text))) {
        for (let tok of m[1].split(/\s+/)) {
          tok = tok.replace(/^["']|["']$/g, '');
          if (!tok || /^(PUBLIC|PRIVATE|INTERFACE|SYSTEM|BEFORE|AFTER)$/i.test(tok)) continue;
          tok = tok.replace(/\$\{(?:CMAKE_SOURCE_DIR|PROJECT_SOURCE_DIR|CMAKE_CURRENT_LIST_DIR|CMAKE_CURRENT_SOURCE_DIR)\}/g, (v) => (/CURRENT/.test(v) ? dir || '.' : '.'));
          if (tok.includes('$') || tok.includes('<')) continue; // other variables and generator expressions are not static
          if (/^[\w.-]+$/.test(tok) && !tok.includes('/') && !/^(\.|\.\.)$/.test(tok) && !dirsWithFiles.has(dir ? `${dir}/${tok}` : tok)) continue; // a target name, not a path
          add(dir ? posix.join(dir, tok) : tok);
        }
      }
    } else {
      const re = /-I\s*([\w./-]+)/g;
      let m;
      while ((m = re.exec(text))) add(dir ? posix.join(dir, m[1]) : m[1]);
    }
  }
  return [...found].sort((a, b) => a.split('/').length - b.split('/').length);
}

export function resolveCInclude(imp, ctx, fromPath) {
  const spec = imp.spec;
  const tries = [];
  if (!(imp._ && imp._.angle)) tries.push(posix.join(posix.dirname(fromPath), spec));
  for (const d of ctx.includeDirs) tries.push(d ? `${d}/${spec}` : spec);
  return tries.map((t) => posix.normalize(t)).find((t) => ctx.set.has(t) && t !== fromPath) || null;
}

export const c = {
  name: 'c',
  exts: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  langNames: { c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', hxx: 'C++' },
  packageUnit: true,
  manifests: ['CMakeLists\\.txt'],
  parse: (text) => ({ imports: cImports(text), symbols: cSymbols(text) }),
  prepare: ({ allPaths, read }) => ({ state: { set: new Set(allPaths), includeDirs: includeDirs(allPaths, read) } }),
  resolve(imp, ctx, file) {
    const hit = resolveCInclude(imp, ctx, file.path);
    return hit ? { files: [hit] } : {};
  },
  entry: (file) => (/\.(c|cc|cpp|cxx)$/.test(file.path) && hasCMain(file._text) ? 'C/C++ main function' : null),
};
