// Pure site building: snippets + page rendering. Runs in Node and in the browser.
import { esc } from './text.mjs';

const MAX_SNIPPET_LINES = 60;
const DEFAULT_LINES = 40;

export const srcKey = (s) => `${s.path}#${s.lines ? s.lines.join('-') : ''}`;

// Evidence pinned to another commit (removed components in a comparison) is not in this tree, so it gets no embedded snippet.
function collectSources(arch) {
  const all = [];
  for (const n of arch.nodes) all.push(...(n.sources || []));
  for (const e of arch.edges) all.push(...(e.sources || []));
  for (const f of arch.flows) for (const s of f.steps) all.push(...(s.sources || []));
  return all.filter((s) => !s.commit);
}

/** `view` is the same repository view the validator uses: exists / read / list. */
export function buildSnippets(arch, view) {
  const out = {};
  for (const s of collectSources(arch)) {
    const key = srcKey(s);
    if (out[key]) continue;
    const kind = view.exists(s.path.replace(/\/$/, ''));
    if (kind === 'dir') {
      const names = view.list ? view.list(s.path) : [];
      out[key] = { type: 'dir', text: names.slice(0, DEFAULT_LINES).join('\n') + (names.length > DEFAULT_LINES ? '\n…' : ''), start: 1 };
    } else if (kind === 'file') {
      const raw = view.read(s.path);
      if (raw == null || raw.includes('\0') || raw.length > 1024 * 1024) continue;
      const lines = raw.replace(/\r\n/g, '\n').split('\n');
      let start = 1, end = Math.min(lines.length, DEFAULT_LINES);
      if (s.lines) { start = s.lines[0]; end = Math.min(s.lines[1], lines.length, start + MAX_SNIPPET_LINES - 1); }
      out[key] = { type: 'file', text: lines.slice(start - 1, end).join('\n'), start, truncated: s.lines ? s.lines[1] > end : lines.length > end };
    }
  }
  return out;
}

export function staticFallback(arch) {
  const p = arch.project;
  const nodeLabel = new Map(arch.nodes.map((n) => [n.id, n.label]));
  const src = (arr) => (arr || []).map((s) => `<code>${esc(s.path)}${s.lines ? ':' + s.lines.join('-') : ''}</code>`).join(', ');
  return `
<h1>${esc(p.name)}</h1>
<p>${esc(p.description || '')}</p>
<p><em>Interactive diagram requires JavaScript. Static summary below.</em></p>
<h2>Components</h2>
<ul>${arch.nodes.map((n) => `<li><strong>${esc(n.label)}</strong> (${esc(n.kind)}): ${esc(n.summary || '')} ${src(n.sources)}</li>`).join('')}</ul>
<h2>Relationships</h2>
<ul>${arch.edges.map((e) => `<li>${esc(nodeLabel.get(e.from))} → ${esc(nodeLabel.get(e.to))}${e.label ? ` (${esc(e.label)})` : ''}</li>`).join('')}</ul>
${arch.flows.map((f) => `<h2>${esc(f.title)}</h2><ol>${f.steps.map((s) => `<li><strong>${esc(s.title)}</strong>: ${esc(s.narration)}</li>`).join('')}</ol>`).join('')}`;
}

/** Makes JSON safe inside <script type="application/json">: no "</script>", no raw U+2028/2029. */
export function safeJson(data) {
  const BS = String.fromCharCode(92);
  return JSON.stringify(data)
    .split('<').join(BS + 'u003c')
    .split(String.fromCharCode(0x2028)).join(BS + 'u2028')
    .split(String.fromCharCode(0x2029)).join(BS + 'u2029');
}

/**
 * Renders index.html from the template. With `inline: { css, js }` the page is fully self-contained
 * (one file, works from disk or inside an iframe); otherwise it links viewer.css / viewer.js.
 */
export function renderPage({ arch, snippets, template, inline }) {
  const fill = { TITLE: esc(`${arch.project.name} architecture`), DESCRIPTION: esc(arch.project.description || ''), STATIC: staticFallback(arch), DATA: safeJson({ arch, snippets }) };
  let html = template.replace(/\{\{(TITLE|DESCRIPTION|STATIC|DATA)\}\}/g, (_, k) => fill[k]);
  if (inline) {
    const styleTag = '<style>' + inline.css + '</style>';
    const scriptTag = '<script>' + inline.js.split('</script').join('<\\/script') + '</script>';
    html = html.replace('<link rel="stylesheet" href="viewer.css">', () => styleTag).replace('<script src="viewer.js"></script>', () => scriptTag);
  }
  return html;
}
