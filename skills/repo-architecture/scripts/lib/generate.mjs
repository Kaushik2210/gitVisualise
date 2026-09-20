// Heuristic generator: scan facts -> architecture.json. Every node/edge/step is derived from something
// found in the repository, and carries `sources` pointing at it. Claude (see SKILL.md) can then refine.
import * as posix from './core/posix.mjs';
import { slug } from './core/text.mjs';
import { matchRequests } from './core/http-core.mjs';
import { PACKAGE_EXTS } from './core/languages.mjs';

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

// Under a standard JVM source root the folders are package names, not project folders: org/springframework/samples/...
// is a package, not an "examples" directory. Only the part outside the source root can be an examples folder.
const JVM_ROOT = /^(?:.*\/)?src\/(?:main|test|integration-test)\/(?:java|kotlin|scala)\//;
export const isExamplePath = (p) => {
  const root = /\.(java|kt|scala)$/.test(p) ? JVM_ROOT.exec(p) : null;
  if (!root) return EXAMPLE_RE.test(p);
  // Only the directories in front of src/main/java can name an examples folder; the rest is a package name.
  return EXAMPLE_RE.test(root[0].replace(/src\/(?:main|test|integration-test)\/(?:java|kotlin|scala)\/$/, ''));
};
const KIND_ORDER = ['entry', 'ui', 'api', 'service', 'data', 'infra', 'entity', 'util', 'config', 'module', 'external', 'test'];

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
  const category = (f) => (f.isTest ? 'tests' : isExamplePath(f.path) ? 'examples' : TOOLING_RE.test(f.path) ? 'tooling' : null);
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
  // In Go, Java and Kotlin the unit of architecture is the package (a directory): files in one package reference each
  // other without imports, so per-file nodes would look disconnected.
  const isPackageLang = (p) => p.endsWith('.go') || PACKAGE_EXTS.has(p.slice(p.lastIndexOf('.') + 1).toLowerCase());
  // In a monorepo each workspace package is one unit, so imports between packages become edges between them.
  const wsDirs = (scan.workspaces || []).slice().sort((a, b) => b.dir.length - a.dir.length);
  const wsOf = (p) => wsDirs.find((w) => p.startsWith(w.dir + '/'));
  const goPackage = (p) => dirOf(p) || '.';
  const keyFor = (p, depth) => {
    const ws = wsOf(p);
    if (ws) return ws.dir;
    if (isPackageLang(p)) return goPackage(p);
    const rel = prefix ? p.slice(prefix.length + 1) : p;
    const segs = rel.split('/');
    if (segs.length === 1) return p; // file at the (prefixed) root => its own unit
    const dirSegs = segs.slice(0, -1).slice(0, depth);
    return (prefix ? prefix + '/' : '') + dirSegs.join('/');
  };
  const maxDepth = Math.max(1, ...files.map((f) => (prefix ? f.path.slice(prefix.length + 1) : f.path).split('/').length - 1));
  let chosen = 0; // 0 = one unit per file
  // opts.layout is in/out: a caller comparing two revisions passes the depth chosen for one so both use the same node ids.
  const layout = opts.layout || {};
  if (Number.isInteger(layout.depth)) chosen = layout.depth;
  else if (files.length > maxNodes) {
    chosen = 1;
    for (let d = maxDepth; d >= 1; d--) {
      const n = new Set(files.map((f) => keyFor(f.path, d))).size;
      if (n <= maxNodes) { chosen = d; break; }
    }
    // Everything collapsed into a handful of directories: per-file nodes say far more for small repos.
    if (files.length <= 40 && new Set(files.map((f) => keyFor(f.path, chosen))).size < 4) chosen = 0;
  }
  layout.depth = chosen;
  const unitKey = (p) => (wsOf(p) ? wsOf(p).dir : isPackageLang(p) ? goPackage(p) : chosen === 0 ? p : keyFor(p, chosen));
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
    const ws = wsDirs.find((w) => w.dir === key);
    const label = ws ? ws.name : isFileUnit ? posix.basename(key) : isRootUnit ? `${scan.repo.name || 'root'} (root)` : `${posix.basename(key)}/`;

    let summary;
    if (isFileUnit) {
      summary = primary.doc || `${langs[0] || 'Source'} file, ${primary.lines} lines.` + (symbols.length ? ` Defines ${list(symbols)}.` : '');
    } else {
      summary = `${ws ? `Workspace package \`${ws.name}\` (${ws.kind})` : isRootUnit ? 'Root package' : `Directory \`${key}\``} with ${fs_.length} ${langs.join('/')} file${fs_.length > 1 ? 's' : ''}: ${list(fs_.map((f) => posix.basename(f.path)))}.` + (symbols.length ? ` Defines ${list(symbols, 5)}.` : '');
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

  // ---------- 4b. HTTP requests between components ----------
  // A client call is linked to a server route only when method and path segments agree (see http-core).
  const httpPairs = new Map();
  for (const { call, route } of matchRequests(scan.routes, scan.apiCalls)) {
    if (!byPath.has(call.file) || !byPath.has(route.file)) continue;
    const from = unitToId.get(unitKey(call.file)), to = unitToId.get(unitKey(route.file));
    if (!from || !to || from === to) continue;
    const p = httpPairs.get(`${from}>${to}`) || { from, to, hits: [] };
    if (!p.hits.some((h) => h.call.file === call.file && h.call.line === call.line && h.route.path === route.path)) p.hits.push({ call, route });
    httpPairs.set(`${from}>${to}`, p);
  }
  const httpEdges = [];
  for (const p of httpPairs.values()) {
    const reqs = [...new Set(p.hits.map((h) => `${h.route.method === 'ANY' ? h.call.method : h.route.method} ${h.route.path}`))];
    const edge = {
      id: `h-${p.from}--${p.to}`.slice(0, 120), from: p.from, to: p.to, kind: 'http', origin: 'auto',
      label: reqs.length === 1 ? reqs[0] : `${reqs.length} API calls`,
      summary: `${reqs.length} HTTP request${reqs.length > 1 ? 's' : ''} handled by routes here: ${list(reqs, 4)}.`,
      // Evidence on both sides: where the request is sent and where the route is registered.
      sources: p.hits.slice(0, 2).flatMap((h) => [{ path: h.call.file, lines: [h.call.line, h.call.line] }, { path: h.route.file, lines: [h.route.line, h.route.line] }]),
    };
    edges.push(edge);
    httpEdges.push({ edge, hits: p.hits, reqs });
  }
  httpEdges.sort((a, b) => b.hits.length - a.hits.length);

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

  // ---------- 5c. Infrastructure and data-model views ----------
  // Services (Docker Compose) and tables / models (SQL, Prisma) become components too. Each one points at the file and lines
  // it was read from, so the validator checks them like any other component.
  const nodeIdIndex = new Map(nodes.map((n) => [n.id, n])); // the code components, before services and tables are added
  const infraSvcs = [];
  const infraList = (scan.infra && scan.infra.services) || [];
  for (const s of infraList.slice(0, 25)) {
    const id = uniqueId('svc-' + slug(s.name));
    const built = s.build ? ` It is built from the ${s.build.dir || 'repository root'} folder.` : '';
    const image = s.image ? ` It runs the image ${s.image}.` : '';
    const ports = s.ports.length ? ` It publishes ${list(s.ports, 3)}.` : '';
    nodes.push({
      id, label: s.name, kind: 'infra', origin: 'auto', tech: ['Docker Compose'],
      summary: `Docker Compose service ${s.name}.${image}${built}${ports}`.trim(),
      sources: [{ path: s.file, lines: [s.line, s.endLine] }],
      _files: [],
    });
    infraSvcs.push({ ...s, id });
  }
  const svcByName = (name, file) => infraSvcs.find((x) => x.name === name && x.file === file) || infraSvcs.find((x) => x.name === name);
  for (const s of infraSvcs) {
    for (const d of s.dependsOn) {
      const to = svcByName(d.name, s.file);
      if (!to || to.id === s.id) continue;
      edges.push({ id: `d-${s.id}--${to.id}`.slice(0, 120), from: s.id, to: to.id, kind: 'depends', origin: 'auto', label: 'depends on', summary: `${s.name} waits for ${to.name} to start.`, sources: [{ path: s.file, lines: [d.line, d.line] }] });
    }
    if (s.build) {
      // Link the service to the code it is built from: the components whose directory is the build context (or inside it).
      const dir = s.build.dir;
      const hits = [...unitToId.entries()].filter(([key]) => (dir ? key === dir || key.startsWith(dir + '/') : false)).map(([, id]) => nodeIdIndex.get(id)).filter(Boolean);
      const rootEntry = !dir ? nodes.filter((n) => n.kind === 'entry').slice(0, 1) : [];
      const targets = [...(hits.length ? hits : rootEntry)].sort((a, b) => (a.kind === 'entry' ? 0 : 1) - (b.kind === 'entry' ? 0 : 1)).slice(0, 3);
      for (const t of targets) edges.push({ id: `b-${s.id}--${t.id}`.slice(0, 120), from: s.id, to: t.id, kind: 'builds', origin: 'auto', label: 'built from', summary: `${s.name} is built from ${t.label}.`, sources: [{ path: s.file, lines: [s.build.line, s.build.line] }] });
    }
  }

  const dm = scan.dataModel || { entities: [], relations: [] };
  const degree = new Map();
  for (const r of dm.relations) { degree.set(r.from, (degree.get(r.from) || 0) + 1); degree.set(r.to, (degree.get(r.to) || 0) + 1); }
  const entityPick = [...dm.entities].sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0)).slice(0, 30);
  const entityNodes = new Map();
  for (const e of entityPick) {
    const id = uniqueId('tbl-' + slug(e.name));
    const cols = e.columns.map((c) => c.name);
    nodes.push({
      id, label: e.name, kind: 'entity', origin: 'auto', tech: [e.kind === 'model' ? 'Prisma' : 'SQL'],
      summary: `${e.kind === 'model' ? 'Prisma model' : 'Table'} ${e.name} with ${cols.length} column${cols.length === 1 ? '' : 's'}${cols.length ? `: ${list(cols, 6)}` : ''}.`,
      sources: [{ path: e.file, lines: [e.line, e.endLine] }],
      _files: [],
    });
    entityNodes.set(e, id);
  }
  for (const r of dm.relations) {
    const from = entityNodes.get(r.from), to = entityNodes.get(r.to);
    if (!from || !to) continue;
    edges.push({ id: `r-${from}--${to}`.slice(0, 120), from, to, kind: 'references', origin: 'auto', label: r.column, summary: `${r.from.name} holds a foreign key (${r.column}) to ${r.to.name}.`, sources: [{ path: r.file, lines: [r.line, r.line] }] });
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
  // One request-flow tour per client -> server pair (the busiest few): the call, the route, then what the route reaches.
  const requestFlows = [];
  for (const { edge, hits, reqs } of httpEdges.slice(0, 3)) {
    const client = nodeById.get(edge.from), server = nodeById.get(edge.to);
    const { call, route } = hits[0];
    const steps = [
      {
        id: 's1', title: `${client.label} sends ${reqs[0]}`, nodes: [client.id], edges: [], origin: 'auto',
        narration: `${client.label} makes an HTTP request, ${reqs[0]}, to the backend. The call is at ${call.file}:${call.line}.`,
        sources: [{ path: call.file, lines: [call.line, call.line] }],
      },
      {
        id: 's2', title: `${server.label} handles it`, nodes: [client.id, server.id], edges: [edge.id], origin: 'auto',
        narration: `The route ${route.method} ${route.path} is registered in ${route.file}:${route.line}, so ${server.label} receives the request.${reqs.length > 1 ? ` The same pair also talks over ${list(reqs.slice(1), 3)}.` : ''}`,
        sources: [{ path: route.file, lines: [route.line, route.line] }],
      },
    ];
    // Follow the handler's imports up to two hops to show where the work goes.
    const seenReq = new Set([client.id, server.id]);
    let frontier = [server.id];
    for (let hop = 0; hop < 2 && steps.length < 6; hop++) {
      const next = [];
      for (const cur of frontier) {
        for (const e of out.get(cur)) {
          if (e.kind !== 'imports' || seenReq.has(e.to) || steps.length >= 6) continue;
          seenReq.add(e.to); next.push(e.to);
          const a = nodeById.get(e.from), b = nodeById.get(e.to);
          steps.push({
            id: `s${steps.length + 1}`, title: `${a.label} → ${b.label}`, nodes: [e.from, e.to], edges: [e.id], origin: 'auto',
            narration: `To do its work, ${a.label} imports ${b.label} — ${lowerFirst(stripDot(e.summary))}. ${sentence(b.summary)}`,
            sources: e.sources.slice(0, 1),
          });
        }
      }
      frontier = next;
    }
    requestFlows.push({
      id: `request-${slug(client.id)}-${slug(server.id)}`.slice(0, 80), title: `Request: ${reqs[0]}`,
      description: `Follows an HTTP request from ${client.label} to the route that handles it in ${server.label}.`, origin: 'auto', steps,
    });
  }
  flows.push(...requestFlows);

  // Infrastructure: which services exist, in what order they start, and which code they are built from.
  if (infraSvcs.length) {
    const depOf = new Map(infraSvcs.map((s) => [s.id, edges.filter((e) => e.kind === 'depends' && e.from === s.id).map((e) => e.to)]));
    const level = new Map();
    const lvl = (id, seenIds = new Set()) => {
      if (level.has(id)) return level.get(id);
      if (seenIds.has(id)) return 0; // a cycle: do not loop
      seenIds.add(id);
      const l = Math.max(-1, ...depOf.get(id).map((d) => lvl(d, seenIds))) + 1;
      level.set(id, l);
      return l;
    };
    infraSvcs.forEach((s) => lvl(s.id));
    const waves = [];
    infraSvcs.forEach((s) => { (waves[level.get(s.id)] ||= []).push(s); });
    const steps = [{
      id: 'i1', title: `${infraSvcs.length} service${infraSvcs.length === 1 ? '' : 's'} in Docker Compose`, nodes: infraSvcs.map((s) => s.id).slice(0, 12), edges: [], origin: 'auto',
      narration: `The compose file declares ${list(infraSvcs.map((s) => s.name), 6)}. Each is a container, and depends_on says which ones must be started before another.`,
      sources: [{ path: infraSvcs[0].file, lines: [infraSvcs[0].line, infraSvcs[0].line] }],
    }];
    waves.filter(Boolean).slice(0, 4).forEach((wave, i) => {
      const es = edges.filter((e) => e.kind === 'depends' && wave.some((s) => s.id === e.from));
      steps.push({
        id: `i${steps.length + 1}`, title: i === 0 ? 'Starts first' : `Then ${list(wave.map((s) => s.name), 2)}`, nodes: [...new Set([...wave.map((s) => s.id), ...es.map((e) => e.to)])].slice(0, 10), edges: es.map((e) => e.id).slice(0, 10), origin: 'auto',
        narration: i === 0
          ? `${list(wave.map((s) => s.name), 4)} ${wave.length > 1 ? 'have' : 'has'} no dependencies, so ${wave.length > 1 ? 'they start' : 'it starts'} first.`
          : `${list(wave.map((s) => `${s.name} (after ${list(depOf.get(s.id).map((d) => infraSvcs.find((x) => x.id === d).name), 3)})`), 3)} start once what they depend on is up.`,
        sources: [es[0] ? es[0].sources[0] : { path: wave[0].file, lines: [wave[0].line, wave[0].line] }],
      });
    });
    const builds = edges.filter((e) => e.kind === 'builds');
    if (builds.length) {
      steps.push({
        id: `i${steps.length + 1}`, title: 'Built from this repository', nodes: [...new Set(builds.flatMap((e) => [e.from, e.to]))].slice(0, 10), edges: builds.map((e) => e.id).slice(0, 10), origin: 'auto',
        narration: `${builds.length} link${builds.length === 1 ? '' : 's'} connect a service to the code it is built from: ${list(builds.map((e) => `${nodeById.get(e.from).label} from ${nodeById.get(e.to).label}`), 3)}.`,
        sources: [builds[0].sources[0]],
      });
    }
    flows.push({ id: 'infrastructure', title: 'Infrastructure', description: 'The services Docker Compose runs, and the order they start in.', origin: 'auto', steps });
  }

  // Data model: the tables or models, then the most connected ones and what they reference.
  if (entityNodes.size) {
    const ents = [...entityNodes.entries()];
    const steps = [{
      id: 'm1', title: `${ents.length} table${ents.length === 1 ? '' : 's'} or model${ents.length === 1 ? '' : 's'}`, nodes: ents.map(([, id]) => id).slice(0, 12), edges: [], origin: 'auto',
      narration: `The schema declares ${list(ents.map(([e]) => e.name), 6)}. Arrows point from the table that holds a foreign key to the table it refers to.`,
      sources: [{ path: ents[0][0].file, lines: [ents[0][0].line, ents[0][0].line] }],
    }];
    for (const [e, id] of ents.filter(([e]) => (degree.get(e) || 0) > 0).slice(0, 3)) {
      const es = edges.filter((x) => x.kind === 'references' && (x.from === id || x.to === id));
      steps.push({
        id: `m${steps.length + 1}`, title: e.name, nodes: [...new Set([id, ...es.flatMap((x) => [x.from, x.to])])].slice(0, 8), edges: es.map((x) => x.id).slice(0, 8), origin: 'auto',
        narration: `${e.name} is connected to ${es.length} other${es.length === 1 ? '' : 's'}: ${list(es.map((x) => x.from === id ? `it refers to ${nodeById.get(x.to).label}` : `${nodeById.get(x.from).label} refers to it`), 3)}.`,
        sources: [es[0].sources[0]],
      });
    }
    flows.push({ id: 'data-model', title: 'Data model', description: 'The tables or models in the schema and how they refer to each other.', origin: 'auto', steps });
  }
  if (tourSteps.length > 1) flows.push({ id: 'tour', title: 'Components by role', description: 'Groups the diagram by what each part does.', origin: 'auto', steps: tourSteps });

  const sp = scan.subPath || null; // analysing one folder (a package) of a larger repository
  const inSub = (m) => !sp || m.file.startsWith(sp + '/');
  // The shallowest manifest names the project (the monorepo root, or the folder being analysed), not a nested package.
  const shallow = (list) => list.slice().sort((x, y) => x.file.split('/').length - y.file.split('/').length)[0];
  const pkg = shallow(scan.manifests.filter((m) => m.description && inSub(m)));
  const project = {
    name: shallow(scan.manifests.filter((m) => m.name && inSub(m)))?.name || (sp ? `${scan.repo.name}/${sp}` : scan.repo.name),
    description: pkg?.description || scan.readme?.text || `Architecture of ${scan.repo.name}.`,
    repoUrl: scan.repo.url, branch: scan.repo.branch, commit: scan.repo.commit,
    ...(scan.repo.dirty ? { dirty: true } : {}),
    generatedAt: new Date().toISOString(), generatedBy: 'heuristic',
    languages: Object.entries(scan.stats.languages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l),
    notes: [
      `Nodes are ${[...units].every(([k, v]) => v.length === 1 && v[0].path === k) ? 'individual source files' : 'directories or packages (and single files)'}; edges are static imports found by the scanner.`,
      ...(skippedNote ? [`Not diagrammed: ${skippedNote}${opts.noIncludeHint ? '' : ' (add them with --include tests,examples,tooling)'}.`] : []),
      ...(sp ? [`Analysing the folder ${'`'}${sp}${'`'} of the repository; imports that leave it are not followed.`] : []),
      ...(wsDirs.length ? [`Monorepo: ${wsDirs.length} workspace packages, each drawn as one component.`] : []),
      ...(opts.extraNotes || []),
    ],
  };
  return { schemaVersion: 1, project, nodes: nodes.map(({ _files, ...n }) => n), edges, flows };
}

function verb(from, e) {
  if (e.kind === 'uses') return 'relies on the library';
  if (e.kind === 'http') return 'sends HTTP requests to';
  return /\.html?$/.test(from.label) ? 'loads' : 'imports';
}
const stripDot =(s) => String(s || '').replace(/\.+\s*$/, '');
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const firstSentence = (s) => (String(s).match(/^.*?[.!?](\s|$)/) || [String(s)])[0].trim();
const sentence = (s) => { const t = firstSentence(s); return /[.!?]$/.test(t) ? t : t + '.'; };
