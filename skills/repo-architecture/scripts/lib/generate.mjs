// Heuristic generator: scan facts -> architecture.json. Every node/edge/step is derived from something
// found in the repository, and carries `sources` pointing at it. Claude (see SKILL.md) can then refine.
import * as posix from './core/posix.mjs';
import { slug } from './core/text.mjs';

const KIND_RULES = [
  ['test', /(^|\/)(tests?|__tests__|spec)(\/|$)/i],
  ['api', /(^|\/)(routes?|controllers?|api|handlers?|endpoints?|resolvers?|views)(\/|$)/i],
  ['data', /(^|\/)(models?|db|database|schemas?|migrations?|store|stores|repositories|entities|prisma)(\/|$)/i],
  ['service', /(^|\/)(services?|lib|core|domain|logic|helpers?|middleware)(\/|$)/i],
  ['ui', /(^|\/)(components?|pages?|screens?|views?|ui|layouts?|templates|public|static|assets|styles?)(\/|$)/i],
  ['config', /(^|\/)(config|configs|settings|env)(\/|$)|(^|\/)[^/]*\.config\.[a-z]+$/i],
  ['util', /(^|\/)(utils?|shared|common)(\/|$)/i],
];

export const EXAMPLE_RE = /(^|\/)(examples?|samples?|demos?|docs?|benchmarks?|fixtures?|playground)(\/|$)/i;
export const TOOLING_RE = /(^|\/)(\.[\w-]+rc(\.[\w]+)?|[\w.-]+\.config(\.[\w-]+)?\.[cm]?[jt]s)$/i;
const KIND_ORDER =['entry', 'ui', 'api', 'service', 'data', 'util', 'config', 'module', 'external', 'test'];

function classify(paths, isEntry, langs, byPathHints) {
  if (isEntry) return 'entry';
  for (const [kind, re] of KIND_RULES) if (paths.some((p) => re.test(p))) return kind;
  if (paths.every((p) => /\.(jsx|tsx|vue|svelte|html)$/.test(p))) return 'ui';
  if (byPathHints?.hasRoutes) return 'api';
  return 'module';
}

const list = (arr, n = 4) => (arr.length <= n ? arr.join(', ') : `${arr.slice(0, n).join(', ')} and ${arr.length - n} more`);

export function generate(scan, opts = {}) {
  const maxNodes = Number(opts.maxNodes) || 14;
  // Tests, examples and tooling config are not the architecture: skip them unless asked (--include).
  const include = new Set(String(opts.include || '').split(',').map((s) => s.trim()).filter(Boolean));
  const category = (f) => (f.isTest ? 'tests' : EXAMPLE_RE.test(f.path) ? 'examples' : TOOLING_RE.test(f.path) ? 'tooling' : null);
  // `opts.alreadySkipped` lets a caller that never downloaded such files (the web app) report their counts.
  const pre = opts.alreadySkipped || {};
  const skipped = { tests: pre.tests || 0, examples: pre.examples || 0, tooling: pre.tooling || 0 };
  const files = scan.files.filter((f) => {
    const c = category(f);
    if (!c || include.has(c)) return true;
    skipped[c]++;
    return false;
  });
  const skippedNote = Object.entries(skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${k} file${n > 1 ? 's' : ''}`).join(', ');
  const byPath = new Map(files.map((f) => [f.path, f]));

  // ---------- 1. choose unit granularity ----------
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  let prefix = '';
  if (files.length) {
    const dirs = files.map((f) => dirOf(f.path).split('/').filter(Boolean));
    let common = dirs[0];
    for (const d of dirs) {
      let i = 0;
      while (i < common.length && i < d.length && common[i] === d[i]) i++;
      common = common.slice(0, i);
    }
    // only strip a common prefix that is purely a source wrapper (src/, app/, lib/ ...)
    prefix = common.join('/');
    if (files.some((f) => dirOf(f.path) === '' )) prefix = '';
  }
  // In Go the unit of architecture is the package (a directory): files in one package never import each other.
  const goPackage = (p) => dirOf(p) || '.';
  const keyFor = (p, depth) => {
    if (p.endsWith('.go')) return goPackage(p);
    const rel = prefix ? p.slice(prefix.length + 1) : p;
    const segs = rel.split('/');
    if (segs.length === 1) return p; // file at the (prefixed) root => its own unit
    const dirSegs = segs.slice(0, -1).slice(0, depth);
    return (prefix ? prefix + '/' : '') + dirSegs.join('/');
  };
  const maxDepth = Math.max(1, ...files.map((f) => (prefix ? f.path.slice(prefix.length + 1) : f.path).split('/').length - 1));
  let chosen = 0; // 0 = one unit per file
  if (files.length > maxNodes) {
    chosen = 1;
    for (let d = maxDepth; d >= 1; d--) {
      const n = new Set(files.map((f) => keyFor(f.path, d))).size;
      if (n <= maxNodes) { chosen = d; break; }
    }
    // Everything collapsed into a handful of directories: per-file nodes say far more for small repos.
    if (files.length <= 40 && new Set(files.map((f) => keyFor(f.path, chosen))).size < 4) chosen = 0;
  }
  const unitKey = (p) => (p.endsWith('.go') ? goPackage(p) : chosen === 0 ? p : keyFor(p, chosen));
  const units = new Map();
  for (const f of files) {
    const k = unitKey(f.path);
    if (!units.has(k)) units.set(k, []);
    units.get(k).push(f);
  }

  // ---------- 2. entry detection ----------
  const entryPaths = new Set(scan.entryPoints.map((e) => e.path));
  const entryReason = new Map(scan.entryPoints.map((e) => [e.path, e.reason]));

  // ---------- 3. nodes ----------
  const nodes = [];
  const unitToId = new Map();
  const usedIds = new Set();
  const uniqueId = (base) => {
    let id = base, i = 2;
    while (usedIds.has(id)) id = `${base}-${i++}`;
    usedIds.add(id);
    return id;
  };
  // Readable ids: the shortest trailing path segments that are unique among units (e.g. "build-mjs").
  const unitKeys = [...units.keys()];
  const shortSlug = (k) => {
    const segs = k.split('/');
    for (let n = 1; n <= segs.length; n++) {
      const id = slug(segs.slice(-n).join('/'));
      if (n === segs.length || !unitKeys.some((o) => o !== k && slug(o.split('/').slice(-n).join('/')) === id)) return id;
    }
  };
  for (const [key, fs_] of units) {
    const isFileUnit = fs_.length === 1 && fs_[0].path === key;
    const isRootUnit = key === '.';
    const id = uniqueId(shortSlug(key));
    unitToId.set(key, id);
    const entries = fs_.filter((f) => entryPaths.has(f.path));
    const routesHere = scan.routes.filter((r) => fs_.some((f) => f.path === r.file));
    const kind = classify(fs_.map((f) => f.path), entries.length > 0, null, { hasRoutes: routesHere.length > 0 });
    const langs = [...new Set(fs_.map((f) => f.lang))];
    const primary = entries[0] || [...fs_].sort((a, b) => b.symbols.length - a.symbols.length || b.lines - a.lines)[0];
    const symbols = fs_.flatMap((f) => f.symbols.map((s) => s.name)).filter((v, i, a) => a.indexOf(v) === i);
    const label = isFileUnit ? posix.basename(key) : isRootUnit ? `${scan.repo.name || 'root'} (root)` : `${posix.basename(key)}/`;

    let summary;
    if (isFileUnit) {
      summary = primary.doc || `${langs[0] || 'Source'} file, ${primary.lines} lines.` + (symbols.length ? ` Defines ${list(symbols)}.` : '');
    } else {
      summary = `${isRootUnit ? 'Root package' : `Directory \`${key}\``} with ${fs_.length} ${langs.join('/')} file${fs_.length > 1 ? 's' : ''}: ${list(fs_.map((f) => posix.basename(f.path)))}.` + (symbols.length ? ` Defines ${list(symbols, 5)}.` : '');
    }
    if (routesHere.length) summary += ` Registers routes: ${list(routesHere.map((r) => `${r.method} ${r.path}`), 4)}.`;
    if (entries.length) summary = `Entry point: ${entryReason.get(entries[0].path)}. ` + summary;

    const sources = [];
    if (!isFileUnit && !isRootUnit) sources.push({ path: key, note: `${fs_.length} files` });
    const show = isFileUnit ? [primary] : [primary, ...fs_.filter((f) => f !== primary).slice(0, 2)];
    for (const f of show) {
      const sym = f.symbols[0];
      sources.push({ path: f.path, ...(sym ? { lines: [sym.line, Math.min(f.lines, sym.line + 20)] } : {}), ...(!isFileUnit ? { note: f.doc || undefined } : {}) });
    }
    nodes.push({
      id, label, kind, origin: 'auto', summary,
      tech: langs.filter(Boolean),
      sources: sources.map((s) => (s.note === undefined ? (({ note, ...r }) => r)(s) : s)),
      _files: fs_.map((f) => f.path),
    });
  }

  // Disambiguate identical labels (e.g. several __init__.py or index.js) with their parent directory.
  const labelCount = {};
  nodes.forEach((n) => { labelCount[n.label] = (labelCount[n.label] || 0) + 1; });
  nodes.forEach((n, i) => {
    if (labelCount[n.label] < 2) return;
    const key = [...units.keys()][i];
    const parent = key.split('/').slice(-2, -1)[0];
    if (parent) n.label = `${parent}/${n.label}`;
  });

  // ---------- 4. edges (aggregated import relationships) ----------
  const edgeMap = new Map();
  for (const f of files) {
    const from = unitToId.get(unitKey(f.path));
    for (const imp of f.imports) {
      if (!imp.resolved || !byPath.has(imp.resolved)) continue;
      const to = unitToId.get(unitKey(imp.resolved));
      if (!to || to === from) continue;
      const k = `${from}>${to}`;
      const e = edgeMap.get(k) || { from, to, count: 0, names: new Set(), sites: [], targets: new Set() };
      e.count++;
      imp.names.forEach((n) => e.names.add(n));
      e.targets.add(imp.resolved);
      if (e.sites.length < 3) e.sites.push({ path: f.path, lines: [imp.line, imp.line] });
      edgeMap.set(k, e);
    }
  }
  const edges = [];
  for (const [k, e] of edgeMap) {
    const names = [...e.names];
    edges.push({
      id: `e-${e.from}--${e.to}`.slice(0, 120), from: e.from, to: e.to, kind: 'imports', origin: 'auto',
      label: e.count === 1 && names.length ? list(names, 3) : `${e.count} imports`,
      summary: `${e.count} import${e.count > 1 ? 's' : ''}${names.length ? ` (${list(names, 6)})` : ''}.`,
      sources: e.sites,
    });
  }

  // ---------- 5. external dependencies ----------
  const idOfFile = (p) => unitToId.get(unitKey(p));
  // Prefer libraries the running code depends on: skip packages only imported by tooling config, and
  // dev-only dependencies whenever runtime dependencies exist.
  const runtimeDeps = new Set(scan.manifests.flatMap((m) => m.dependencies || []));
  const devOnly = new Set(scan.manifests.flatMap((m) => m.devDependencies || []).filter((d) => !runtimeDeps.has(d)));
  let externals = scan.externals.filter((x) => x.files.some((p) => byPath.has(p)));
  const runtime = externals.filter((x) => !devOnly.has(x.name));
  if (runtime.length) externals = runtime;
  externals = externals.slice(0, 6);
  for (const x of externals) {
    const id = uniqueId('ext-' + slug(x.name));
    nodes.push({
      id, label: x.name, kind: 'external', external: true, origin: 'auto',
      summary: `External dependency${x.version ? ` (${x.version})` : ''} imported by ${x.files.length} file${x.files.length > 1 ? 's' : ''}: ${list(x.files.map((p) => posix.basename(p)), 3)}.`,
      tech: x.kind !== 'external' ? [`${x.kind} library`] : [],
      sources: [x.declaredAt ? { path: x.declaredAt.file, lines: [x.declaredAt.line, x.declaredAt.line] } : { path: x.firstRef.path, lines: [x.firstRef.line, x.firstRef.line] }],
      _files: [],
    });
    const users = new Map();
    for (const p of x.files) {
      const from = idOfFile(p);
      if (from && !users.has(from)) users.set(from, p);
    }
    for (const [from, p] of users) {
      edges.push({ id: `e-${from}--${id}`.slice(0, 120), from, to: id, kind: 'uses', origin: 'auto', label: 'uses', summary: `Imports \`${x.name}\`.`, sources: [{ path: p, lines: [x.firstRef.path === p ? x.firstRef.line : 1, x.firstRef.path === p ? x.firstRef.line : 1] }] });
    }
  }

  // ---------- 6. flows ----------
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map(nodes.map((n) => [n.id, []]));
  const inDeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) { out.get(e.from).push(e); inDeg.set(e.to, inDeg.get(e.to) + 1); }
  out.forEach((arr) => arr.sort((a, b) => (nodeById.get(a.to).external ? 1 : 0) - (nodeById.get(b.to).external ? 1 : 0)));

  const flows = [];
  const startNode = nodes.find((n) => n.kind === 'entry') ||
    [...nodes].filter((n) => !n.external).sort((a, b) => (inDeg.get(a.id) - inDeg.get(b.id)) || (out.get(b.id).length - out.get(a.id).length))[0];

  if (startNode) {
    const steps = [];
    const seen = new Set([startNode.id]);
    steps.push({
      id: 's1', title: `Start at ${startNode.label}`, nodes: [startNode.id], edges: [], origin: 'auto',
      narration: `Execution starts at ${startNode.label}. ${sentence(startNode.summary)} Follow the highlighted connections to see how the rest of the code is wired together.`,
      sources: startNode.sources.slice(0, 1),
    });
    const queue = [startNode.id];
    while (queue.length && steps.length < 12) {
      const cur = queue.shift();
      for (const e of out.get(cur)) {
        if (seen.has(e.to) || steps.length >= 12) continue;
        seen.add(e.to);
        queue.push(e.to);
        const from = nodeById.get(e.from), to = nodeById.get(e.to);
        steps.push({
          id: `s${steps.length + 1}`, title: `${from.label} → ${to.label}`, nodes: [e.from, e.to], edges: [e.id], origin: 'auto',
          narration: `${from.label} ${verb(from, e)} ${to.label}${e.summary ? ` — ${lowerFirst(stripDot(e.summary))}` : ''}. ${sentence(to.summary)}`,
          sources: e.sources.slice(0, 1),
        });
      }
    }
    const missed = nodes.filter((n) => !seen.has(n.id) && !n.external);
    if (missed.length) {
      steps.push({
        id: `s${steps.length + 1}`, title: 'Not reached by imports', nodes: missed.map((n) => n.id).slice(0, 8), edges: [], origin: 'auto',
        narration: `These modules are not reachable from the entry point through static imports: ${list(missed.map((n) => n.label), 6)}. They may be loaded dynamically, run separately, or be unused.`,
        sources: missed[0].sources.slice(0, 1),
      });
    }
    flows.push({ id: 'startup', title: 'How the code is wired', description: 'Follows import relationships outward from the entry point.', origin: 'auto', steps });
  }

  const byKind = new Map();
  for (const n of nodes) (byKind.get(n.kind) || byKind.set(n.kind, []).get(n.kind)).push(n);
  const tourSteps = [];
  for (const kind of KIND_ORDER) {
    const group = byKind.get(kind);
    if (!group || kind === 'test') continue;
    tourSteps.push({
      id: `t${tourSteps.length + 1}`, title: `${kind[0].toUpperCase()}${kind.slice(1)} (${group.length})`, nodes: group.map((n) => n.id), edges: [], origin: 'auto',
      narration: `${group.length} ${kind === 'module' ? 'general' : kind} ${group.length > 1 ? 'parts' : 'part'}: ${group.map((n) => `${n.label} — ${stripDot(firstSentence(n.summary))}`).slice(0, 4).join('; ')}${group.length > 4 ? '; and more' : ''}.`,
      sources: group[0].sources.slice(0, 1),
    });
  }
  if (tourSteps.length > 1) flows.push({ id: 'tour', title: 'Components by role', description: 'Groups the diagram by what each part does.', origin: 'auto', steps: tourSteps });

  const pkg = scan.manifests.find((m) => m.description);
  const project = {
    name: scan.manifests.find((m) => m.name)?.name || scan.repo.name,
    description: pkg?.description || scan.readme?.text || `Architecture of ${scan.repo.name}.`,
    repoUrl: scan.repo.url, branch: scan.repo.branch, commit: scan.repo.commit,
    ...(scan.repo.dirty ? { dirty: true } : {}),
    generatedAt: new Date().toISOString(), generatedBy: 'heuristic',
    languages: Object.entries(scan.stats.languages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l),
    notes: [
      `Nodes are ${[...units].every(([k, v]) => v.length === 1 && v[0].path === k) ? 'individual source files' : 'directories or packages (and single files)'}; edges are static imports found by the scanner.`,
      ...(skippedNote ? [`Not diagrammed: ${skippedNote}${opts.noIncludeHint ? '' : ' (add them with --include tests,examples,tooling)'}.`] : []),
      ...(opts.extraNotes || []),
    ],
  };
  return { schemaVersion: 1, project, nodes: nodes.map(({ _files, ...n }) => n), edges, flows };
}

function verb(from, e) {
  if (e.kind === 'uses') return 'relies on the library';
  return /\.html?$/.test(from.label) ? 'loads' : 'imports';
}
const stripDot =(s) => String(s || '').replace(/\.+\s*$/, '');
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const firstSentence = (s) => (String(s).match(/^.*?[.!?](\s|$)/) || [String(s)])[0].trim();
const sentence = (s) => { const t = firstSentence(s); return /[.!?]$/.test(t) ? t : t + '.'; };
