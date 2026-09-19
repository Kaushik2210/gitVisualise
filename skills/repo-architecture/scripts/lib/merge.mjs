// Merge a freshly generated architecture into an existing one without destroying human/Claude edits.
//
// Ownership rules (per node / edge / flow / step, keyed by id):
//   origin "manual" | "claude"  -> kept verbatim, the generator never overwrites it
//   locked: true                -> kept verbatim
//   locked: ["summary","label"] -> generated item is used, but those fields keep the existing value
//   `position` on a node        -> always kept (hand-placed layout)
//   origin "auto" (or missing)  -> replaced by the generated version; dropped if it no longer exists
// Items that only exist in the generated data are added. Steps of an "auto" flow follow the same rules.

const isOwned = (item) => item && (item.origin === 'manual' || item.origin === 'claude' || item.locked === true);

function mergeList(existing = [], generated = [], report, kind, mergeChildren) {
  const gen = new Map(generated.map((g) => [g.id, g]));
  const seen = new Set();
  const out = [];
  for (const old of existing) {
    const g = gen.get(old.id);
    seen.add(old.id);
    if (isOwned(old)) {
      out.push(old);
      report.kept.push(`${kind} ${old.id}`);
    } else if (g) {
      let merged = { ...g };
      if (Array.isArray(old.locked)) {
        for (const f of old.locked) if (f in old) merged[f] = old[f];
        merged.locked = old.locked;
        report.partial.push(`${kind} ${old.id} (${old.locked.join(', ')})`);
      }
      if (old.position) merged.position = old.position;
      if (mergeChildren) merged = mergeChildren(merged, old, g);
      out.push(merged);
    } else report.dropped.push(`${kind} ${old.id}`);
  }
  for (const g of generated) {
    if (!seen.has(g.id)) {
      out.push(g);
      report.added.push(`${kind} ${g.id}`);
    }
  }
  return out;
}

export function mergeArchitecture(existing, generated) {
  const report = { kept: [], partial: [], dropped: [], added: [] };
  if (!existing) return { arch: generated, report: { ...report, added: ['(new file)'] } };

  const nodes = mergeList(existing.nodes, generated.nodes, report, 'node');
  const edges = mergeList(existing.edges, generated.edges, report, 'edge');
  const flows = mergeList(existing.flows, generated.flows, report, 'flow', (merged, old, gen) => ({
    ...merged,
    steps: mergeList(old.steps, gen.steps, report, `step ${old.id}/`),
  }));

  // Project metadata: refresh machine facts, keep fields a human locked or wrote.
  const p = existing.project || {};
  const keep = {};
  if (p.origin === 'manual' || p.origin === 'claude') Object.assign(keep, { origin: p.origin, name: p.name, description: p.description });
  else for (const k of p.locked || []) if (k in p) keep[k] = p[k];
  if (p.locked) keep.locked = p.locked;
  if (p.links) keep.links = p.links;
  const project = { ...generated.project, ...keep };
  if (p.origin === 'claude' || p.origin === 'manual') project.generatedBy = p.generatedBy || p.origin;

  return { arch: { schemaVersion: generated.schemaVersion, project, nodes, edges, flows }, report };
}
