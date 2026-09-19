// Validates architecture.json against the schema AND against the real repository:
// every source path must exist (exact case), line ranges must be inside the file, flows must
// reference real nodes/edges, and file paths mentioned in prose must exist. Nothing invented gets through.
import { countLines } from './text.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const FILE_EXT_RE = /\.(m?[jt]sx?|cjs|vue|svelte|py|go|rs|java|kt|rb|php|cs|html?|css|scss|json|ya?ml|toml|md|sh|sql|txt|lock|env)$/i;
const ORIGINS = new Set(['auto', 'claude', 'manual']);

/**
 * Pure validation. `view` abstracts the repository:
 *   exists(rel) -> 'file' | 'dir' | null   (exact case)
 *   read(rel)   -> text | null
 *   hasBasename(name) -> boolean            (any file with that name anywhere)
 */
export function validateCore(arch, view) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!arch || typeof arch !== 'object') return { errors: ['architecture.json is not an object'], warnings, stats: {} };
  if (arch.schemaVersion !== 1) err(`schemaVersion must be 1 (got ${JSON.stringify(arch.schemaVersion)})`);
  const project = arch.project || {};
  if (!project.name) err('project.name is required');
  if (!Array.isArray(arch.nodes) || !arch.nodes.length) err('nodes must be a non-empty array');
  for (const k of ['edges', 'flows']) if (!Array.isArray(arch[k])) err(`${k} must be an array`);
  if (errors.length) return { errors, warnings, stats: {} };

  const lineCache = new Map();
  const linesOf = (rel) => {
    if (!lineCache.has(rel)) {
      const t = view.read(rel);
      lineCache.set(rel, t == null ? null : { count: countLines(t.replace(/\r\n/g, '\n')), text: t.replace(/\r\n/g, '\n').split('\n') });
    }
    return lineCache.get(rel);
  };

  const checkSources = (where, sources, { required }) => {
    if (sources == null) { if (required) err(`${where}: needs at least one source`); return; }
    if (!Array.isArray(sources)) return err(`${where}: sources must be an array`);
    if (required && !sources.length) err(`${where}: needs at least one source`);
    sources.forEach((s, i) => {
      const w = `${where} sources[${i}]`;
      if (!s || typeof s.path !== 'string') return err(`${w}: missing path`);
      const kind = view.exists(s.path.replace(/\/$/, ''));
      if (!kind) return err(`${w}: "${s.path}" does not exist in the repository (paths are relative to the repo root, exact case)`);
      if (s.lines != null) {
        if (kind === 'dir') return err(`${w}: lines given for a directory`);
        const ok = Array.isArray(s.lines) && s.lines.length === 2 && s.lines.every((n) => Number.isInteger(n)) && s.lines[0] >= 1 && s.lines[0] <= s.lines[1];
        if (!ok) return err(`${w}: lines must be [start, end] integers with 1 <= start <= end`);
        const f = linesOf(s.path);
        if (!f) return warn(`${w}: could not read "${s.path}" to check lines`);
        if (s.lines[1] > f.count) err(`${w}: lines ${s.lines[0]}-${s.lines[1]} exceed "${s.path}" (${f.count} lines)`);
      }
    });
  };

  const hasBasename = (name) => view.hasBasename(name);

  const checkText = (where, text) => {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim().replace(/:\d+(-\d+)?$/, '').replace(/\/$/, '');
      if (!tok || /\s/.test(tok) || /[*{}()<>=]/.test(tok) || /^(https?:|\/|@|\.\.?$)/.test(tok)) continue; // urls, routes, npm scopes, globs, code
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(tok) && !view.exists(tok.split('/')[0])) continue; // Go/Java-style module path (github.com/x/y), not a repo file
      const isPath = tok.includes('/');
      if (!isPath && !FILE_EXT_RE.test(tok)) continue;
      if (isPath) {
        if (view.exists(tok)) continue;
        const first = tok.split('/')[0];
        if (view.exists(first)) err(`${where}: mentions \`${m[1]}\` but that path does not exist in the repository`);
        else warn(`${where}: mentions \`${m[1]}\` which is not a path in this repository (fine if it is a package subpath)`);
      } else if (!view.exists(tok) && !hasBasename(tok)) {
        err(`${where}: mentions file \`${m[1]}\` but no such file exists in the repository`);
      }
    }
    for (const m of text.matchAll(/https?:\/\/[^\s)`'"<>]+/g)) {
      const url = m[0].replace(/[.,;:!?]+$/, '');
      if (!project.repoUrl || !url.startsWith(project.repoUrl)) warn(`${where}: contains external URL ${url} (not verified; remove unless it is essential)`);
    }
  };

  // ---- nodes ----
  const nodeIds = new Set();
  arch.nodes.forEach((n, i) => {
    const w = `node[${i}]${n && n.id ? ` "${n.id}"` : ''}`;
    if (!n || typeof n !== 'object') return err(`${w}: not an object`);
    if (!n.id || !ID_RE.test(n.id)) err(`${w}: id must match ${ID_RE}`);
    else if (nodeIds.has(n.id)) err(`${w}: duplicate id`);
    else nodeIds.add(n.id);
    if (!n.label) err(`${w}: label is required`);
    if (!n.kind) err(`${w}: kind is required`);
    if (n.origin && !ORIGINS.has(n.origin)) err(`${w}: origin must be auto | claude | manual`);
    if (!n.summary) warn(`${w}: has no summary`);
    if (n.position && !(Number.isFinite(n.position.x) && Number.isFinite(n.position.y))) err(`${w}: position needs numeric x and y`);
    checkSources(w, n.sources, { required: !n.external });
    if (n.external && (!n.sources || !n.sources.length)) warn(`${w}: external node has no source reference (add the manifest line that declares it)`);
    checkText(`${w} summary`, n.summary);
  });

  // ---- edges ----
  const edgeById = new Map();
  arch.edges.forEach((e, i) => {
    const w = `edge[${i}]${e && e.id ? ` "${e.id}"` : ''}`;
    if (!e || typeof e !== 'object') return err(`${w}: not an object`);
    if (!e.id || !ID_RE.test(e.id)) err(`${w}: id must match ${ID_RE}`);
    else if (edgeById.has(e.id)) err(`${w}: duplicate id`);
    else edgeById.set(e.id, e);
    if (!nodeIds.has(e.from)) err(`${w}: from "${e.from}" is not a node`);
    if (!nodeIds.has(e.to)) err(`${w}: to "${e.to}" is not a node`);
    if (e.from === e.to) warn(`${w}: self-loop`);
    checkSources(w, e.sources, { required: false });
    if (!e.sources || !e.sources.length) warn(`${w}: no source evidence for this relationship`);
    if (e.kind === 'imports') {
      for (const s of e.sources || []) {
        const f = s.lines && linesOf(s.path);
        if (f && !f.text.slice(s.lines[0] - 1, s.lines[1]).some((l) => /import|require|from|src\s*=|include|use\b|load/i.test(l) || /^\s*(?:[\w.]+\s+)?"[^"]+"\s*$/.test(l))) warn(`${w}: kind "imports" but ${s.path}:${s.lines[0]} does not look like an import`);
      }
    }
    checkText(`${w} summary`, e.summary);
  });

  // ---- flows & narration ----
  const inFlow = new Set();
  const flowIds = new Set();
  arch.flows.forEach((fl, i) => {
    const w = `flow[${i}]${fl && fl.id ? ` "${fl.id}"` : ''}`;
    if (!fl || typeof fl !== 'object') return err(`${w}: not an object`);
    if (!fl.id || !ID_RE.test(fl.id)) err(`${w}: id must match ${ID_RE}`);
    else if (flowIds.has(fl.id)) err(`${w}: duplicate id`);
    else flowIds.add(fl.id);
    if (!fl.title) err(`${w}: title is required`);
    if (!Array.isArray(fl.steps) || !fl.steps.length) return err(`${w}: steps must be a non-empty array`);
    const stepIds = new Set();
    fl.steps.forEach((s, j) => {
      const sw = `${w} step[${j}]${s && s.id ? ` "${s.id}"` : ''}`;
      if (!s || typeof s !== 'object') return err(`${sw}: not an object`);
      if (!s.id || !ID_RE.test(s.id)) err(`${sw}: id must match ${ID_RE}`);
      else if (stepIds.has(s.id)) err(`${sw}: duplicate id`);
      else stepIds.add(s.id);
      if (!s.title) err(`${sw}: title is required`);
      if (!s.narration || !String(s.narration).trim()) err(`${sw}: narration is required`);
      else if (String(s.narration).length > 700) warn(`${sw}: narration is long (${String(s.narration).length} chars); aim for 1-3 sentences`);
      const sn = s.nodes || [], se = s.edges || [];
      if (!sn.length && !se.length) err(`${sw}: must reference at least one node or edge`);
      sn.forEach((id) => { if (!nodeIds.has(id)) err(`${sw}: node "${id}" does not exist`); else inFlow.add(id); });
      se.forEach((id) => {
        if (!edgeById.has(id)) err(`${sw}: edge "${id}" does not exist`);
        else { const e = edgeById.get(id); inFlow.add(e.from); inFlow.add(e.to); }
      });
      checkSources(sw, s.sources, { required: false });
      checkText(`${sw} narration`, s.narration);
    });
  });
  for (const id of nodeIds) if (!inFlow.has(id)) warn(`node "${id}" is not covered by any flow step`);
  if (!arch.flows.length) warn('no flows defined: the visualization will have nothing to play');

  return { errors, warnings, stats: { nodes: arch.nodes.length, edges: arch.edges.length, flows: arch.flows.length, steps: arch.flows.reduce((n, f) => n + (f.steps?.length || 0), 0) } };
}
