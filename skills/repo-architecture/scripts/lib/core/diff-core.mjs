// Pure architecture comparison: given the architecture of two revisions of a repository, produce one merged
// architecture in which every component and relationship is marked added, removed, changed or same, plus a
// "What changed" tour. Items are matched by id (ids are derived from paths, so a moved file is a removal plus
// an addition). Nothing is inferred beyond that: `changed` means the scanner produced a different description.

const stripDot = (s) => String(s || '').replace(/\.+\s*$/, '');
// Copied text is shown in prose, where a backticked path would be checked against the head tree: drop the backticks.
const first = (s) => (String(s || '').match(/^.*?[.!?](\s|$)/) || [String(s || '')])[0].trim().replace(/`/g, '');
const list = (arr, n = 4) => (arr.length <= n ? arr.join(', ') : `${arr.slice(0, n).join(', ')} and ${arr.length - n} more`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const nodeSig = (n) => ({ label: n.label, kind: n.kind, tech: n.tech || [], summary: n.summary, paths: (n.sources || []).map((s) => s.path) });
const edgeSig = (e) => ({ from: e.from, to: e.to, kind: e.kind, label: e.label, summary: e.summary });

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
  const bEdges = new Map(base.edges.map((e) => [e.id, e]));
  const hEdges = new Map(head.edges.map((e) => [e.id, e]));

  const nodes = [];
  for (const n of head.nodes) {
    const old = bNodes.get(n.id);
    if (!old) nodes.push({ ...n, diff: 'added' });
    else if (same(nodeSig(old), nodeSig(n))) nodes.push({ ...n, diff: 'same' });
    else nodes.push({ ...n, diff: 'changed', diffNote: old.summary === n.summary ? 'Description or dependencies changed.' : `Before: ${stripDot(first(old.summary))}.` });
  }
  for (const n of base.nodes) {
    if (hNodes.has(n.id)) continue;
    nodes.push({ ...n, diff: 'removed', sources: (n.sources || []).map((s) => ({ ...s, commit: pin })) });
  }
  const edges = [];
  for (const e of head.edges) {
    const old = bEdges.get(e.id);
    edges.push({ ...e, diff: !old ? 'added' : same(edgeSig(old), edgeSig(e)) ? 'same' : 'changed' });
  }
  for (const e of base.edges) {
    if (!hEdges.has(e.id)) edges.push({ ...e, diff: 'removed', sources: (e.sources || []).map((s) => ({ ...s, commit: pin })) });
  }

  const pick = (arr, d) => arr.filter((x) => x.diff === d);
  const summary = {
    nodes: { added: pick(nodes, 'added').length, removed: pick(nodes, 'removed').length, changed: pick(nodes, 'changed').length },
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
      narration: `${ns.length} component${ns.length > 1 ? 's were' : ' was'} ${verb}: ${ns.slice(0, 4).map((n) => `${n.label} — ${stripDot(d === 'changed' ? n.diffNote.replace(/\.$/, '') : first(n.summary))}`).join('; ')}${ns.length > 4 ? '; and more' : ''}.`,
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
      narration: `Comparing the two revisions: ${n.added} component${n.added === 1 ? '' : 's'} added, ${n.removed} removed and ${n.changed} changed; ${e.added} relationship${e.added === 1 ? '' : 's'} added and ${e.removed} removed. The steps that follow walk through each group.`,
      sources: touched.length ? touched[0].sources.slice(0, 1) : [],
    });
    nodeStep('added', 'Added components', 'added');
    nodeStep('removed', 'Removed components', 'removed');
    nodeStep('changed', 'Changed components', 'changed');
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

