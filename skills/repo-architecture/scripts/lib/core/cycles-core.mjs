// Circular dependencies: groups of components that import each other, directly or through a chain.
// Pure and dependency-free. Only edges you pass in are considered, so a cycle is always something the
// scanner actually saw as imports, never an inference.

/**
 * Strongly connected groups with at least two members (Tarjan, iterative so a deep import chain cannot overflow the stack).
 * @param {string[]} ids   node ids to consider
 * @param {{id: string, from: string, to: string}[]} edges   directed edges; ones touching an unknown id are ignored
 * @returns {{nodes: string[], edges: string[], path: string[]}[]}   per group: its members, the edges between them, and
 *   one concrete loop (`path` is the sequence of edge ids, ending where it began), largest groups first
 */
export function findCycles(ids, edges) {
  const known = new Set(ids);
  const out = new Map(ids.map((i) => [i, []]));
  for (const e of edges) if (known.has(e.from) && known.has(e.to) && e.from !== e.to) out.get(e.from).push(e);

  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], groups = [];
  let counter = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work = [{ v: root, i: 0 }];
    index.set(root, counter); low.set(root, counter); counter++; stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1], v = frame.v, adj = out.get(v);
      if (frame.i < adj.length) {
        const w = adj[frame.i++].to;
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++; stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1].v; low.set(p, Math.min(low.get(p), low.get(v))); }
        if (low.get(v) === index.get(v)) {
          const group = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); group.push(w); } while (w !== v);
          if (group.length > 1) groups.push(group);
        }
      }
    }
  }

  return groups
    .map((members) => {
      const set = new Set(members);
      const inside = edges.filter((e) => set.has(e.from) && set.has(e.to) && e.from !== e.to);
      return { nodes: members.slice().sort((a, b) => ids.indexOf(a) - ids.indexOf(b)), edges: inside.map((e) => e.id), path: loopIn(members, inside) };
    })
    .sort((a, b) => b.nodes.length - a.nodes.length || ids.indexOf(a.nodes[0]) - ids.indexOf(b.nodes[0]));
}

/** The shortest loop through the group's first member (BFS), as edge ids; deterministic given the edge order. */
function loopIn(members, edges) {
  const start = members.slice().sort()[0];
  const out = new Map();
  for (const e of edges) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
  const prev = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const v = queue.shift();
    for (const e of out.get(v) || []) {
      if (e.to === start) {
        const path = [e.id];
        for (let at = v; prev.get(at); at = prev.get(at).from) path.unshift(prev.get(at).id);
        return path;
      }
      if (!prev.has(e.to)) { prev.set(e.to, e); queue.push(e.to); }
    }
  }
  return [];
}

/**
 * The loops a generated architecture reports, read back from its "cycles" flow so the CLI, the PR comment and the viewer all say the
 * same thing: [{ title, key, loop: 'a → b → a', components: [label], evidence: { path, line } }], largest group first. `key` is the
 * sorted component ids, which identifies a loop group across two revisions. [] when there is no such flow.
 */
export function cycleReport(arch) {
  const flow = (arch.flows || []).find((f) => f.id === 'cycles');
  if (!flow) return [];
  const label = new Map((arch.nodes || []).map((n) => [n.id, n.label]));
  return flow.steps.slice(1).map((st) => {
    const src = (st.sources || [])[0];
    return {
      title: st.title,
      key: (st.nodes || []).slice().sort().join('|'),
      loop: String(st.narration || '').split('. Each arrow')[0],
      components: (st.nodes || []).map((id) => label.get(id) || id),
      evidence: src ? { path: src.path, line: src.lines ? src.lines[0] : null } : null,
    };
  });
}

/** Which loops a change introduced and which it resolved, by the set of components in each loop group. */
export function compareCycles(baseArch, headArch) {
  const base = cycleReport(baseArch || {}), head = cycleReport(headArch || {});
  const baseKeys = new Set(base.map((l) => l.key)), headKeys = new Set(head.map((l) => l.key));
  return { introduced: head.filter((l) => !baseKeys.has(l.key)), resolved: base.filter((l) => !headKeys.has(l.key)) };
}
