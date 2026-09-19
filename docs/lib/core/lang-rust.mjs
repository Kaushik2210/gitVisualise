// Rust support for the scanner: `mod` declarations and `use` paths resolved to real files through the module tree,
// Cargo dependencies, and workspace crates. Pure (no Node APIs): runs in the CLI and in the browser.
//
// Rule: a path is only resolved when it walks to a module file that exists in the repository. Anything else (items
// inside a module, std, undeclared crates) is dropped rather than guessed.

const lineOf = (text, idx) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** Expands `a::{b, c::{d, self}}` into ['a::b', 'a::c::d', 'a::c']. Aliases (`as x`) and trailing `::*` are removed. */
export function expandUse(tree) {
  const s = tree.replace(/\s+/g, ' ').trim();
  const open = s.indexOf('{');
  if (open < 0) {
    const p = s.replace(/\s+as\s+\w+$/, '').replace(/^::/, '').replace(/::\*$/, '').replace(/::self$/, '').trim();
    return p && p !== 'self' ? [p] : [];
  }
  let depth = 0, close = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return [];
  const prefix = s.slice(0, open).replace(/::$/, '');
  const inner = s.slice(open + 1, close);
  const parts = [];
  let d = 0, cur = '';
  for (const c of inner) {
    if (c === '{') d++;
    if (c === '}') d--;
    if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const out = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (t === 'self') { if (prefix) out.push(prefix); continue; }
    for (const e of expandUse(prefix ? `${prefix}::${t}` : t)) out.push(e);
  }
  return out;
}

/** `mod name;` declarations and `use` statements. */
export function rustImports(text) {
  const out = [];
  let m;
  const mods = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm;
  while ((m = mods.exec(text))) out.push({ spec: `mod:${m[1]}`, line: lineOf(text, m.index), names: [m[1]], rust: { kind: 'mod', name: m[1] } });
  const uses = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm;
  while ((m = uses.exec(text))) {
    const line = lineOf(text, m.index);
    for (const p of expandUse(m[1])) out.push({ spec: p, line, names: [p.split('::').pop()], rust: { kind: 'use', segs: p.split('::') } });
  }
  return out;
}

const norm = (n) => String(n).replace(/-/g, '_');

/** Splits a Cargo.toml into { section: text } and reads [dependencies]-style tables into { name, version, line }. */
function cargoSections(txt) {
  const sections = [];
  const re = /^\[([^\]\n]+)\]\s*$/gm;
  let m, prev = null;
  while ((m = re.exec(txt))) {
    if (prev) prev.end = m.index;
    prev = { name: m[1].trim(), start: m.index + m[0].length, end: txt.length, headerIdx: m.index };
    sections.push(prev);
  }
  return sections;
}

export function parseCargo(txt) {
  const info = { name: null, deps: [], members: [] };
  if (!txt) return info;
  for (const sec of cargoSections(txt)) {
    const body = txt.slice(sec.start, sec.end);
    if (sec.name === 'package') info.name = (/^\s*name\s*=\s*["']([^"']+)["']/m.exec(body) || [])[1] || null;
    else if (sec.name === 'workspace') {
      const mm = /members\s*=\s*\[([\s\S]*?)\]/.exec(body);
      if (mm) info.members = [...mm[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    } else if (sec.name === 'dependencies') {
      const base = txt.slice(0, sec.start).split('\n').length; // line of the header
      body.split('\n').forEach((l, i) => {
        const d = /^\s*([A-Za-z_][\w-]*)\s*(?:=\s*(.*)|\.[\w-]+\s*=)/.exec(l);
        if (!d) return;
        const v = /^["']([^"']+)["']/.exec(d[2] || '') || /version\s*=\s*["']([^"']+)["']/.exec(d[2] || '');
        info.deps.push({ name: d[1], version: v ? v[1] : null, line: base + i });
      });
    }
  }
  return info;
}

/** Builds what resolution needs: every crate (a directory with a Cargo.toml that has a [package]) and its dependencies. */
export function buildRustContext(allPaths, read) {
  const allSet = new Set(allPaths);
  const crates = [];
  for (const file of allPaths.filter((p) => /(^|\/)Cargo\.toml$/.test(p))) {
    const info = parseCargo(read(file));
    if (!info.name) continue; // a pure workspace manifest has no code of its own
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const srcDir = allPaths.some((p) => p.startsWith(dir ? `${dir}/src/` : 'src/')) ? (dir ? `${dir}/src` : 'src') : dir;
    crates.push({ name: info.name, key: norm(info.name), dir, srcDir, file, deps: info.deps, allSet });
  }
  crates.sort((a, b) => b.dir.length - a.dir.length); // nearest (deepest) crate first
  return { crates, allSet };
}

const join = (a, b) => (a ? `${a}/${b}` : b);

/** The file of a module path inside a crate, or null. [] is the crate root (lib.rs or main.rs). */
function moduleFile(crate, segs) {
  const { srcDir, allSet } = crate;
  if (!segs.length) return ['lib.rs', 'main.rs'].map((n) => join(srcDir, n)).find((p) => allSet.has(p)) || null;
  const base = join(srcDir, segs.join('/'));
  return [`${base}.rs`, `${base}/mod.rs`].find((p) => allSet.has(p)) || null;
}

/** The crate a file belongs to and its module path (from the crate root), or null. */
export function crateOf(ctx, filePath) {
  const crate = ctx.crates.find((c) => !c.dir || filePath.startsWith(c.dir + '/'));
  if (!crate) return null;
  const rel = filePath.slice(crate.srcDir ? crate.srcDir.length + 1 : 0);
  if (crate.srcDir && !filePath.startsWith(crate.srcDir + '/')) return { crate, mod: null };
  if (/^(lib|main)\.rs$/.test(rel)) return { crate, mod: [] };
  if (rel.startsWith('bin/')) return { crate, mod: [] }; // extra binaries are their own roots
  const segs = rel.replace(/\.rs$/, '').split('/');
  if (segs[segs.length - 1] === 'mod') segs.pop();
  return { crate, mod: segs };
}

/**
 * Resolves one import to { file, external }. `file` is a repository path, `external` a declared dependency name.
 */
export function resolveRustImport(imp, ctx, fromPath) {
  const here = crateOf(ctx, fromPath);
  if (!here || here.mod === null) return {};
  const { crate } = here;
  const cur = here.mod;

  if (imp.rust.kind === 'mod') {
    const f = moduleFile(crate, [...cur, imp.rust.name]);
    return f && f !== fromPath ? { file: f } : {};
  }

  const segs = imp.rust.segs.slice();
  let target = crate;
  let base;
  let rest;
  if (segs[0] === 'crate') { base = []; rest = segs.slice(1); }
  else if (segs[0] === 'self') { base = cur; rest = segs.slice(1); }
  else if (segs[0] === 'super') {
    base = cur.slice();
    let i = 0;
    while (segs[i] === 'super') { base = base.slice(0, -1); i++; }
    rest = segs.slice(i);
  } else if (moduleFile(crate, [...cur, segs[0]])) { base = cur; rest = segs; } // a child module in scope
  else {
    const other = ctx.crates.find((c) => c.key === norm(segs[0]) && c !== crate);
    if (other) { target = other; base = []; rest = segs.slice(1); }
    else {
      if (['std', 'core', 'alloc', 'proc_macro', 'test'].includes(segs[0])) return {};
      const dep = crate.deps.find((d) => norm(d.name) === norm(segs[0]));
      return dep ? { external: dep.name } : {};
    }
  }
  let mod = base.slice();
  for (const s of rest) {
    if (moduleFile(target, [...mod, s])) mod.push(s);
    else break; // the remaining segments name items inside the module
  }
  const f = moduleFile(target, mod);
  return f && f !== fromPath ? { file: f } : {};
}

/** Every crate's dependency, for the manifest list and external nodes. */
export const rustDependencies = (ctx) => ctx.crates.flatMap((c) => c.deps.map((d) => ({ ...d, file: c.file })));
