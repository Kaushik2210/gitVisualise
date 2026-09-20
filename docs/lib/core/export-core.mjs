// Pure exporters: architecture.json -> Mermaid or PlantUML text, so a tour can be pasted into a README,
// a wiki page or a pull request (GitHub renders Mermaid natively). No repository text is ever trusted:
// every label goes through an escaper, and node ids are generated (n0, n1, ...) rather than copied.

// Colours per node kind, in the same family as the viewer.
const KIND_STYLE = {
  entry: ['#d1fae5', '#10b981'], ui: ['#ede9fe', '#8b5cf6'], api: ['#ffedd5', '#f97316'], service: ['#dbeafe', '#3b82f6'],
  data: ['#fce7f3', '#ec4899'], util: ['#e5e7eb', '#6b7280'], config: ['#fef9c3', '#ca8a04'], module: ['#e0e7ff', '#6366f1'],
  external: ['#f3f4f6', '#9ca3af'], test: ['#f1f5f9', '#94a3b8'], entity: ['#fae8ff', '#c026d3'], infra: ['#cffafe', '#0891b2'],
};
const DIFF_STYLE = { added: ['#dcfce7', '#16a34a'], removed: ['#fee2e2', '#dc2626'], changed: ['#fef3c7', '#d97706'] };

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Mermaid quoted-string escaping: quotes and angle brackets become entity codes, and "#" is escaped first. */
export function mermaidText(s, max = 60) {
  let t = oneLine(s);
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return t.replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
}

/** PlantUML quoted-string escaping. */
export function plantText(s, max = 60) {
  let t = oneLine(s);
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return t.replace(/\\/g, '/').replace(/"/g, "'");
}

const idMap = (arch) => new Map(arch.nodes.map((n, i) => [n.id, `n${i}`]));
const classOf = (n) => (n.diff && n.diff !== 'same' ? `d_${n.diff}` : `k_${String(n.kind || 'module').replace(/[^a-z0-9]/gi, '_')}`);

/**
 * @param arch  a validated architecture.json (a comparison result works too: added/removed/changed are coloured)
 * @param opts  { direction: 'LR' | 'TB', groups: boolean }
 */
export function toMermaid(arch, opts = {}) {
  const dir = opts.direction === 'TB' ? 'TB' : 'LR';
  const ids = idMap(arch);
  const lines = [`flowchart ${dir}`];
  const decl = (n) => `${ids.get(n.id)}["${mermaidText(n.label, 40)}<br/>${mermaidText(n.kind || 'module', 20)}"]:::${classOf(n)}`;

  const grouped = opts.groups !== false && arch.nodes.some((n) => n.group);
  if (grouped) {
    const groups = [...new Set(arch.nodes.filter((n) => n.group).map((n) => n.group))];
    groups.forEach((g, i) => {
      lines.push(`  subgraph g${i}["${mermaidText(g, 40)}"]`);
      arch.nodes.filter((n) => n.group === g).forEach((n) => lines.push(`    ${decl(n)}`));
      lines.push('  end');
    });
    arch.nodes.filter((n) => !n.group).forEach((n) => lines.push(`  ${decl(n)}`));
  } else {
    arch.nodes.forEach((n) => lines.push(`  ${decl(n)}`));
  }

  arch.edges.forEach((e) => {
    const a = ids.get(e.from), b = ids.get(e.to);
    if (!a || !b) return;
    const label = e.label ? `|"${mermaidText(e.label, 30)}"|` : '';
    const dotted = e.kind === 'http' || e.diff === 'removed';
    lines.push(`  ${a} ${dotted ? '-.->' : '-->'}${label} ${b}`);
  });
  // linkStyle indexes follow the order edges were emitted (skipping any with unknown endpoints)
  const emitted = arch.edges.filter((e) => ids.get(e.from) && ids.get(e.to));
  emitted.forEach((e, i) => {
    const c = e.diff === 'added' ? '#16a34a' : e.diff === 'removed' ? '#dc2626' : e.diff === 'changed' ? '#d97706' : null;
    if (c) lines.push(`  linkStyle ${i} stroke:${c},stroke-width:2px`);
  });

  const used = new Set(arch.nodes.map(classOf));
  for (const k of Object.keys(KIND_STYLE)) {
    const cls = `k_${k}`;
    if (used.has(cls)) lines.push(`  classDef ${cls} fill:${KIND_STYLE[k][0]},stroke:${KIND_STYLE[k][1]},color:#111827`);
  }
  for (const c of used) {
    if (c.startsWith('k_') && !KIND_STYLE[c.slice(2)]) lines.push(`  classDef ${c} fill:#e0e7ff,stroke:#6366f1,color:#111827`);
    if (c.startsWith('d_')) lines.push(`  classDef ${c} fill:${DIFF_STYLE[c.slice(2)][0]},stroke:${DIFF_STYLE[c.slice(2)][1]},color:#111827`);
  }
  return lines.join('\n') + '\n';
}

export function toPlantUml(arch, opts = {}) {
  const ids = idMap(arch);
  const lines = ['@startuml', opts.direction === 'TB' ? 'top to bottom direction' : 'left to right direction', 'skinparam shadowing false', 'skinparam rectangle {', '  RoundCorner 12', '}'];
  const decl = (n, pad) => {
    const style = n.diff && n.diff !== 'same' ? DIFF_STYLE[n.diff] : KIND_STYLE[n.kind] || KIND_STYLE.module;
    return `${pad}rectangle "${plantText(n.label, 40)}\\n<size:10>${plantText(n.kind || 'module', 20)}</size>" as ${ids.get(n.id)} ${style ? `#${style[0].slice(1)};line:${style[1].slice(1)}` : ''}`;
  };
  const grouped = opts.groups !== false && arch.nodes.some((n) => n.group);
  if (grouped) {
    const groups = [...new Set(arch.nodes.filter((n) => n.group).map((n) => n.group))];
    for (const g of groups) {
      lines.push(`package "${plantText(g, 40)}" {`);
      arch.nodes.filter((n) => n.group === g).forEach((n) => lines.push(decl(n, '  ')));
      lines.push('}');
    }
    arch.nodes.filter((n) => !n.group).forEach((n) => lines.push(decl(n, '')));
  } else {
    arch.nodes.forEach((n) => lines.push(decl(n, '')));
  }
  for (const e of arch.edges) {
    const a = ids.get(e.from), b = ids.get(e.to);
    if (!a || !b) continue;
    const arrow = e.kind === 'http' || e.diff === 'removed' ? '..>' : '-->';
    lines.push(`${a} ${arrow} ${b}${e.label ? ` : ${plantText(e.label, 30)}` : ''}`);
  }
  lines.push('@enduml');
  return lines.join('\n') + '\n';
}

export const EXPORT_FORMATS = { mermaid: toMermaid, plantuml: toPlantUml };
