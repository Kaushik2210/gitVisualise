// Elixir: `alias`, `import`, `require` and `use` name a module, and a module is defined by `defmodule` in some file, so resolution goes
// through an index of the modules the repository really defines (nested `defmodule`s get their enclosing module as a prefix, as in the
// language). Third-party modules become external nodes only when mix.exs declares a dependency whose atom matches the module's first
// one or two segments (`Phoenix.Router` <- :phoenix, `PlugCowboy` <- :plug_cowboy); anything else, including the standard library, is dropped.

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
// Compared with underscores removed, so `Phoenix.PubSub` (phoenix + pub_sub) still finds `:phoenix_pubsub`: only an exact match of the whole atom counts.
const norm = (s) => s.replace(/_/g, '').toLowerCase();

/** Lines inside heredocs (`"""` ... `"""`, which is where @moduledoc / @doc examples live) and comment-only lines, which hold no code. */
function textLines(text) {
  const skip = new Set();
  const lines = text.split('\n');
  let inDoc = false;
  for (let i = 0; i < lines.length; i++) {
    const count = (lines[i].match(/"""|'''/g) || []).length;
    if (inDoc) { skip.add(i + 1); if (count % 2 === 1) inDoc = false; continue; }
    if (/^\s*#/.test(lines[i])) { skip.add(i + 1); continue; }
    if (count % 2 === 1) { skip.add(i + 1); inDoc = true; }
  }
  return skip;
}

/** The modules a file defines, with nesting resolved: [{ name, line, indent }]. */
export function elixirModules(text) {
  const out = [], stack = [], skip = textLines(text);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (skip.has(i + 1)) continue;
    const m = /^([ \t]*)defmodule\s+([A-Z][\w.]*)\s+do\b/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const name = stack.length ? `${stack[stack.length - 1].name}.${m[2]}` : m[2];
    stack.push({ indent, name });
    out.push({ name, line: i + 1, indent });
  }
  return out;
}

// `alias A.B`, `alias A.B, as: C`, `import A`, `require A`, `use A, opt: 1`, and the multi form `alias A.{B, C.D}` (which may span lines).
const DIRECTIVE = /^([ \t]*)(alias|import|require|use)\s+(__MODULE__|[A-Z][\w]*)((?:\.(?:[A-Z]\w*|__MODULE__))*)(?:\.\{([^}]*)\})?/gm;

export function elixirImports(text) {
  const out = [], skip = textLines(text), mods = elixirModules(text);
  const enclosing = (line) => { let cur = null; for (const m of mods) if (m.line <= line) cur = m; return cur ? cur.name : null; };
  let m;
  DIRECTIVE.lastIndex = 0;
  while ((m = DIRECTIVE.exec(text))) {
    const line = lineOf(text, m.index + m[1].length);
    if (skip.has(line)) continue;
    let base = m[3] + m[4];
    if (base.startsWith('__MODULE__')) { const here = enclosing(line); if (!here) continue; base = here + base.slice('__MODULE__'.length); }
    if (m[5] !== undefined) {
      for (const part of m[5].split(',')) {
        const p = part.trim().split(/\s+/)[0];
        if (/^[A-Z][\w.]*$/.test(p)) out.push({ spec: `${base}.${p}`, line, names: [p.split('.').pop()] });
      }
    } else out.push({ spec: base, line, names: [base.split('.').pop()] });
  }
  return out;
}

/** mix.exs -> declared dependencies as { name, version, line }, plus the entry modules it names (`mod:`, `main_module:`). */
export function parseMix(text) {
  const deps = [], entries = new Set();
  const at = text.search(/\bdefp?\s+deps\b/);
  if (at >= 0) {
    const body = text.slice(at);
    const re = /\{\s*:([a-z_]\w*)\s*(?:,\s*(?:"([^"]*)")?)?/g;
    let m;
    while ((m = re.exec(body))) deps.push({ name: m[1], version: m[2] || null, line: lineOf(text, at + m.index) });
  }
  let e;
  const modRe = /\b(?:mod|main_module):\s*\{?\s*([A-Z][\w.]*)/g;
  while ((e = modRe.exec(text))) entries.add(e[1]);
  return { deps, entries };
}

export const elixir = {
  name: 'elixir',
  exts: ['ex', 'exs'],
  langNames: { ex: 'Elixir', exs: 'Elixir' },
  packageUnit: false,
  manifests: ['mix\\.exs'],
  parse: (text) => {
    const modules = elixirModules(text);
    return { imports: elixirImports(text), ...(modules.length ? { package: modules[0].name } : {}), symbols: modules.map((x) => ({ name: x.name, line: x.line })) };
  },
  prepare({ files, allPaths, read }) {
    const index = new Map(); // module name -> files that define it
    for (const f of files) for (const mod of elixirModules(f._text || '')) { (index.get(mod.name) || index.set(mod.name, []).get(mod.name)).push(f.path); }
    const deps = [], manifests = [], entryModules = new Set(), declared = new Map(); // normalised atom -> atom
    for (const p of allPaths.filter((x) => /(^|\/)mix\.exs$/.test(x))) {
      const { deps: d, entries } = parseMix(read(p) || '');
      d.forEach((x) => { deps.push({ name: x.name, version: x.version, file: p, line: x.line }); declared.set(norm(x.name), x.name); });
      entries.forEach((x) => entryModules.add(x));
      manifests.push({ file: p, type: 'mix', dependencies: d.map((x) => x.name) });
    }
    return { state: { index, declared, entryModules }, deps, manifests };
  },
  resolve(imp, st, file) {
    const hits = (st.index.get(imp.spec) || []).filter((p) => p !== file.path);
    if (hits.length) return { files: hits };
    if (st.index.has(imp.spec)) return {}; // defined only in the importing file itself
    const segs = imp.spec.split('.');
    for (const cand of [norm(segs[0]), segs[1] ? norm(segs[0] + segs[1]) : null]) if (cand && st.declared.has(cand)) return { external: st.declared.get(cand) };
    return {};
  },
  entry(file, st) {
    for (const m of elixirModules(file._text || '')) if (st.entryModules.has(m.name)) return `OTP application / escript entry (${m.name}, named in mix.exs)`;
    if (/^[ \t]*use\s+Mix\.Task\b/m.test(file._text || '')) return 'Mix task';
    return null;
  },
};
