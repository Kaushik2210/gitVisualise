// Pure architecture comparison: given the architecture of two revisions of a repository, produce one merged
// architecture in which every component and relationship is marked added, removed, changed, moved or same, plus a
// "What changed" tour. Items are matched by id (ids are derived from paths). A removal and an addition are folded into
// one `moved` component only by a deliberately strict rule (see `findMoves`); in any doubt they stay a removal plus an
// addition. Nothing else is inferred: `changed` means the scanner produced a different description.

const stripDot = (s) => String(s || '').replace(/\.+\s*$/, '');
// Copied text is shown in prose, where a backticked path would be checked against the head tree: drop the backticks.
const first = (s) => (String(s || '').match(/^.*?[.!?](\s|$)/) || [String(s || '')])[0].trim().replace(/`/g, '');
const list = (arr, n = 4) => (arr.length <= n ? arr.join(', ') : `${arr.slice(0, n).join(', ')} and ${arr.length - n} more`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const nodeSig = (n) => ({ label: n.label, kind: n.kind, tech: n.tech || [], summary: n.summary, paths: (n.sources || []).map((s) => s.path) });
const edgeSig = (e) => ({ from: e.from, to: e.to, kind: e.kind, label: e.label, summary: e.summary });

const basename = (p) => String(p || '').split('/').pop();
const dirname = (p) => String(p || '').split('/').slice(0, -1).join('/');
const pathsOf = (n) => (n.sources || []).map((s) => s.path);
// What must be identical for two components to be the same file in two places: label, technologies, the scanner's
// description (its line count and what it defines, so an edit nearly always shows) and the file names. Only the directories may differ
// (and with them the kind, which the scanner infers from the directory).
const moveSig = (n) => JSON.stringify([basename(n.label), n.tech || [], n.summary, pathsOf(n).map(basename)]);
const elsewhere = (a, b) => { const [x, y] = [pathsOf(a), pathsOf(b)]; return x.length > 0 && x.length === y.length && x.some((p, i) => dirname(p) !== dirname(y[i])); };

/**
 * Finds the components that are, beyond reasonable doubt, the same file in a new place. Strict by design: when in doubt the
 * result is a removal plus an addition. Two cases, both requiring an identical `moveSig` (so an edit as well as a move never
 * qualifies) and different directories:
 *  - the same id on both sides (ids come from the file name unless it collides), or
 *  - different ids (a name collision put the directory in the id): exactly one removed and exactly one added component carry
 *    that signature, so two look-alikes pair with nothing.
 * @returns Map<headId, baseNode>
 */
export function findMoves(bNodes, hNodes) {
  const moved = new Map();
  for (const [id, n] of hNodes) {
    const old = bNodes.get(id);
    if (old && moveSig(old) === moveSig(n) && elsewhere(old, n)) moved.set(id, old);
  }
  const group = (arr) => {
    const m = new Map();
    for (const n of arr) m.set(moveSig(n), [...(m.get(moveSig(n)) || []), n]);
    return m;
  };
  const r = group([...bNodes.values()].filter((n) => !hNodes.has(n.id) && pathsOf(n).length));
  const a = group([...hNodes.values()].filter((n) => !bNodes.has(n.id) && pathsOf(n).length));
  for (const [k, rs] of r) {
    const as = a.get(k);
    if (rs.length === 1 && as && as.length === 1 && elsewhere(rs[0], as[0])) moved.set(as[0].id, rs[0]);
  }
  return moved;
}

/**
 * @param base   architecture of the older revision
 * @param head   architecture of the newer revision (its flows and sources are kept as they are)
 * @param opts   { baseRef, headRef, baseCommit, headCommit }
 * @returns {{ arch, summary }}
 */
export function diffArchitectures(base, head, opts = {}) {
  const pin = opts.baseCommit || opts.baseRef || 'base';
  const bNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const hNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const movedFrom = findMoves(bNodes, hNodes);
  const renamed = new Map([...movedFrom].filter(([to, old]) => old.id !== to).map(([to, old]) => [old.id, to]));
  // A moved component keeps its relationships: when its id changed, the base edges are renamed to match the head's.
  const renameEdge = (e) => {
    let id = e.id;
    for (const [from, to] of renamed) id = id.split(from).join(to);
    return { ...e, id, from: renamed.get(e.from) || e.from, to: renamed.get(e.to) || e.to };
  };
  const bEdges = new Map(base.edges.map((e) => { const r = renameEdge(e); return [r.id, r]; }));
  const hEdges = new Map(head.edges.map((e) => [e.id, e]));

  const nodes = [];
  for (const n of head.nodes) {
    const old = bNodes.get(n.id);
    const origin = movedFrom.get(n.id);
    if (origin) {
      const was = pathsOf(origin);
      nodes.push({ ...n, diff: 'moved', movedFrom: { paths: was, commit: pin }, diffNote: `Was at ${list(was, 2)}.` });
    } else if (!old) nodes.push({ ...n, diff: 'added' });
    else if (same(nodeSig(old), nodeSig(n))) nodes.push({ ...n, diff: 'same' });
    else nodes.push({ ...n, diff: 'changed', diffNote: old.summary === n.summary ? 'Description or dependencies changed.' : `Before: ${stripDot(first(old.summary))}.` });
  }
  for (const n of base.nodes) {
    if (hNodes.has(n.id) || renamed.has(n.id)) continue;
    nodes.push({ ...n, diff: 'removed', sources: (n.sources || []).map((s) => ({ ...s, commit: pin })) });
  }
  const edges = [];
  for (const e of head.edges) {
    const old = bEdges.get(e.id);
    edges.push({ ...e, diff: !old ? 'added' : same(edgeSig(old), edgeSig(e)) ? 'same' : 'changed' });
  }
  for (const e of [...bEdges.values()]) {
    if (!hEdges.has(e.id)) edges.push({ ...e, diff: 'removed', sources: (e.sources || []).map((s) => ({ ...s, commit: pin })) });
  }

  const pick = (arr, d) => arr.filter((x) => x.diff === d);
  const summary = {
    nodes: { added: pick(nodes, 'added').length, removed: pick(nodes, 'removed').length, changed: pick(nodes, 'changed').length, moved: pick(nodes, 'moved').length },
    edges: { added: pick(edges, 'added').length, removed: pick(edges, 'removed').length, changed: pick(edges, 'changed').length },
  };
  summary.empty = [...Object.values(summary.nodes), ...Object.values(summary.edges)].every((n) => n === 0);

  const label = (id) => nodes.find((n) => n.id === id)?.label || id;
  const steps = [];
  const nodeStep = (d, title, verb) => {
    const ns = pick(nodes, d);
    if (!ns.length) return;
    steps.push({
      id: `w${steps.length + 1}`, title: `${title} (${ns.length})`, nodes: ns.map((n) => n.id).slice(0, 10), edges: [], origin: 'auto',
      narration: `${ns.length} component${ns.length > 1 ? 's were' : ' was'} ${verb}: ${ns.slice(0, 4).map((n) => `${n.label} — ${stripDot(d === 'changed' || d === 'moved' ? n.diffNote.replace(/\.$/, '') : first(n.summary))}`).join('; ')}${ns.length > 4 ? '; and more' : ''}.`,
      sources: ns[0].sources.slice(0, 1),
    });
  };
  const edgeStep = (d, title, verb) => {
    const es = pick(edges, d);
    if (!es.length) return;
    steps.push({
      id: `w${steps.length + 1}`, title: `${title} (${es.length})`, nodes: [...new Set(es.flatMap((e) => [e.from, e.to]))].slice(0, 10), edges: es.map((e) => e.id).slice(0, 10), origin: 'auto',
      narration: `${es.length} relationship${es.length > 1 ? 's were' : ' was'} ${verb}: ${es.slice(0, 4).map((e) => `${label(e.from)} → ${label(e.to)}${e.label ? ` (${e.label})` : ''}`).join('; ')}${es.length > 4 ? '; and more' : ''}.`,
      sources: (es[0].sources || []).slice(0, 1),
    });
  };
  if (!summary.empty) {
    const n = summary.nodes, e = summary.edges;
    const touched = nodes.filter((x) => x.diff !== 'same');
    steps.push({
      id: 'w0', title: `${opts.baseRef || 'Base'} → ${opts.headRef || 'head'}`, nodes: touched.map((x) => x.id).slice(0, 12), edges: [], origin: 'auto',
      narration: `Comparing the two revisions: ${n.added} component${n.added === 1 ? '' : 's'} added, ${n.moved ? `${n.removed} removed, ${n.changed} changed and ${n.moved} moved` : `${n.removed} removed and ${n.changed} changed`}; ${e.added} relationship${e.added === 1 ? '' : 's'} added and ${e.removed} removed. The steps that follow walk through each group.`,
      sources: touched.length ? touched[0].sources.slice(0, 1) : [],
    });
    nodeStep('added', 'Added components', 'added');
    nodeStep('removed', 'Removed components', 'removed');
    nodeStep('changed', 'Changed components', 'changed');
    nodeStep('moved', 'Moved components', 'moved');
    edgeStep('added', 'New relationships', 'added');
    edgeStep('removed', 'Removed relationships', 'removed');
    edgeStep('changed', 'Changed relationships', 'changed');
  }
  const flows = steps.length
    ? [{ id: 'what-changed', title: 'What changed', description: `Components and relationships that differ between ${opts.baseRef || 'the base'} and ${opts.headRef || 'the head'}.`, origin: 'auto', steps }, ...head.flows.filter((f) => f.id !== 'what-changed')]
    : head.flows;

  const arch = {
    ...head,
    project: {
      ...head.project,
      compare: { base: { ref: opts.baseRef || null, commit: opts.baseCommit || null }, head: { ref: opts.headRef || null, commit: opts.headCommit || head.project.commit || null } },
      notes: [...(head.project.notes || []), `Comparison: ${opts.baseRef || 'base'}${opts.baseCommit ? ` (${String(opts.baseCommit).slice(0, 7)})` : ''} → ${opts.headRef || 'head'}. Removed items link to the base commit.`],
    },
    nodes, edges, flows,
  };
  return { arch, summary };
}

