// Infrastructure view: what the repository's deployment files declare and how the pieces relate. Three sources feed it:
//  - Docker Compose: services, `depends_on`, and the directory each one is built from;
//  - Kubernetes manifests: Deployments / StatefulSets / DaemonSets, the Services that select them by label, and the Ingress rules
//    that route to those Services;
//  - Terraform: `resource` blocks and the references between them (`aws_lb.web.arn`).
// Every element and every relationship carries the file and line it was read from, exactly like a component found in code, and
// a relationship is only drawn when it can be matched exactly (a selector that matches no workload, or a reference to a resource
// that does not exist, produces nothing). Templated files (Helm, Kustomize patches) and dynamic expressions are not read.
import * as posix from './posix.mjs';
import { parseYaml, parseYamlDocs } from './yaml-lite.mjs';
import { countLines } from './text.mjs';

/** Compose file names: docker-compose.yml, docker-compose.prod.yaml, compose.yml, compose.override.yaml ... */
export const COMPOSE_RE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;

/** Terraform files; `.terraform/` holds downloaded providers and modules, not this repository's own configuration. */
export const TERRAFORM_RE = /(^|\/)[^/]+\.tf$/i;
const YAML_RE = /\.ya?ml$/i;
const K8S_HINT_RE = /(^|\/)(k8s|kube|kubernetes|manifests?|deploy|deployments?|overlays?|base|infra|infrastructure)(\/|$)/i;
const MAX_INFRA_FILE = 512 * 1024;
const MAX_YAML = 60;

/**
 * The YAML files worth reading as Kubernetes manifests. Whether a file is one is decided by its content (`apiVersion` and
 * `kind`), so the caller needs the candidates first: files in conventional folders come first, then the shallowest.
 */
export function k8sCandidates(paths, limit = MAX_YAML) {
  return paths
    .filter((p) => YAML_RE.test(p) && !COMPOSE_RE.test(p) && !/^\.github\//.test(p) && !/(^|\/)(pnpm-workspace|Chart|values|\.pre-commit-config|mkdocs|\.gitlab-ci)[^/]*\.ya?ml$/i.test(p) && p.split('/').length <= 6)
    .map((p) => ({ p, hint: K8S_HINT_RE.test(p) ? 0 : 1, depth: p.split('/').length }))
    .sort((a, b) => a.hint - b.hint || a.depth - b.depth || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map((x) => x.p);
}

const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v) : v == null ? [] : [v]);
const lineOfItem = (container, keyOrIndex, fallback) => {
  const l = container && container.$lines ? container.$lines[keyOrIndex] : null;
  return Number.isInteger(l) ? l : fallback;
};

/**
 * @param paths all repository paths
 * @param read  (path) -> text | null
 * @returns { services: [{ name, file, line, endLine, image, build: { context, dir, line } | null, ports, dependsOn: [{ name, line }] }] }
 */
export function extractInfra(paths, read) {
  const services = [...composeServices(paths, read), ...k8sServices(paths, read), ...terraformServices(paths, read)];
  return { services: services.slice(0, 60) };
}

function composeServices(paths, read) {
  const services = [];
  const seen = new Set();
  for (const file of paths) {
    if (!COMPOSE_RE.test(file) || file.split('/').length > 4) continue;
    const text = read(file);
    if (!text) continue;
    const doc = parseYaml(text);
    const svcs = doc && doc.services && typeof doc.services === 'object' ? doc.services : null;
    if (!svcs) continue;
    const names = Object.keys(svcs);
    const startLines = names.map((n) => lineOfItem(svcs, n, 1)).sort((a, b) => a - b);
    const totalLines = countLines(text.replace(/\r\n/g, '\n')); // the same count the validator uses
    for (const name of names) {
      const svc = svcs[name] && typeof svcs[name] === 'object' ? svcs[name] : {};
      const line = lineOfItem(svcs, name, 1);
      const next = startLines.find((l) => l > line);
      let build = null;
      if (svc.build != null) {
        const ctx = typeof svc.build === 'string' ? svc.build : svc.build && typeof svc.build === 'object' ? svc.build.context : '.';
        if (typeof ctx === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(ctx)) {
          const dir = posix.normalize(posix.join(posix.dirname(file) === '.' ? '' : posix.dirname(file), ctx || '.'));
          build = { context: ctx, dir: dir === '.' ? '' : dir, line: lineOfItem(svc, 'build', line) };
        }
      }
      const deps = svc.depends_on;
      const dependsOn = asList(deps).map((d, i) => ({ name: String(d), line: lineOfItem(deps, Array.isArray(deps) ? i : d, lineOfItem(svc, 'depends_on', line)) }));
      const key = `${file}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      services.push({
        name, file, line, endLine: Math.min(totalLines, Math.max(line, next ? next - 1 : line + 30)),
        image: typeof svc.image === 'string' ? svc.image : null,
        build,
        ports: asList(svc.ports).map(String).slice(0, 6),
        dependsOn,
      });
    }
  }
  return services;
}

// ---------- Kubernetes ----------
const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
const nsOf = (doc) => str(obj(doc.metadata)?.namespace) || 'default';

/**
 * Manifests (any `.yaml` with `apiVersion` and `kind`, several documents per file allowed):
 *  - workload -> its container images and ports;
 *  - Service -> the workloads in the same namespace whose pod labels contain every key=value of its `selector` (exactly: an empty
 *    selector, or one that matches nothing, links to nothing);
 *  - Ingress -> the Services its rules name as backends (only those that exist in the same namespace).
 */
function k8sServices(paths, read) {
  const found = [];
  for (const file of k8sCandidates(paths)) {
    const text = read(file);
    if (!text || text.length > MAX_INFRA_FILE || !/^apiVersion:/m.test(text) || !/^kind:/m.test(text) || text.includes('{{')) continue;
    for (const d of parseYamlDocs(text)) {
      const doc = obj(d.value);
      const kind = doc && str(doc.kind);
      if (!doc || !kind || !str(doc.apiVersion) || !obj(doc.metadata) || !str(doc.metadata.name)) continue;
      if (!WORKLOADS.has(kind) && kind !== 'Service' && kind !== 'Ingress') continue;
      found.push({ doc, kind, name: str(doc.metadata.name), ns: nsOf(doc), file, line: d.start, endLine: d.end });
    }
  }
  const label = (r) => `${r.ns !== 'default' ? `${r.ns}/` : ''}${r.kind}/${r.name}`;
  const byKey = new Map();
  for (const r of found) if (!byKey.has(label(r))) byKey.set(label(r), r); // the first declaration wins
  const items = [...byKey.values()];
  const out = [];
  for (const r of items) {
    const spec = obj(r.doc.spec) || {};
    const svc = { name: label(r), file: r.file, line: r.line, endLine: r.endLine, tech: 'Kubernetes', role: r.kind, image: null, build: null, ports: [], dependsOn: [] };
    if (WORKLOADS.has(r.kind)) {
      const podSpec = obj(obj(spec.template)?.spec) || {};
      const containers = asList(Array.isArray(podSpec.containers) ? podSpec.containers : []).filter(obj);
      svc.images = containers.map((c) => str(c.image)).filter(Boolean).slice(0, 3);
      svc.image = svc.images[0] || null;
      svc.ports = containers.flatMap((c) => (Array.isArray(c.ports) ? c.ports : []).map((p) => str(obj(p)?.containerPort)).filter(Boolean)).slice(0, 6);
    } else if (r.kind === 'Service') {
      const sel = obj(spec.selector);
      svc.ports = (Array.isArray(spec.ports) ? spec.ports : []).map((p) => str(obj(p)?.port)).filter(Boolean).slice(0, 6);
      if (sel) {
        for (const w of items) {
          if (!WORKLOADS.has(w.kind) || w.ns !== r.ns) continue;
          const labels = obj(obj(obj(w.doc.spec)?.template)?.metadata)?.labels;
          if (!obj(labels) || !Object.keys(sel).length) continue;
          if (Object.keys(sel).every((k) => k in labels && str(labels[k]) === str(sel[k]) && str(sel[k]) !== null)) {
            const first = Object.keys(sel)[0];
            svc.dependsOn.push({
              name: label(w), line: lineOfItem(sel, first, lineOfItem(spec, 'selector', r.line)), kind: 'routes', label: 'selects',
              summary: `${r.name} sends traffic to the pods of ${w.kind} ${w.name}, whose labels match its selector ${Object.keys(sel).map((k) => `${k}=${sel[k]}`).join(', ')}.`,
            });
          }
        }
      }
    } else {
      for (const rule of Array.isArray(spec.rules) ? spec.rules : []) {
        const paths2 = obj(obj(rule)?.http)?.paths;
        for (const p of Array.isArray(paths2) ? paths2 : []) {
          const backend = obj(obj(p)?.backend);
          const holder = backend && obj(backend.service) ? backend.service : backend;
          const target = holder && (str(holder.name) || str(holder.serviceName));
          if (!target) continue;
          const to = items.find((x) => x.kind === 'Service' && x.name === target && x.ns === r.ns);
          if (!to || svc.dependsOn.some((d) => d.name === label(to))) continue;
          svc.dependsOn.push({
            name: label(to), line: lineOfItem(holder, 'name', lineOfItem(holder, 'serviceName', r.line)), kind: 'routes', label: 'routes to',
            summary: `${r.name} routes requests${str(obj(rule).host) ? ` for ${str(obj(rule).host)}` : ''} to Service ${to.name}.`,
          });
        }
      }
    }
    svc.summary = k8sSummary(r.kind, r.name, svc);
    out.push(svc);
  }
  return out;
}

function k8sSummary(kind, name, svc) {
  const image = svc.images && svc.images.length ? ` It runs ${svc.images.length === 1 ? 'the image' : 'the images'} ${svc.images.join(', ')}.` : '';
  const ports = svc.ports.length ? ` It ${kind === 'Service' ? 'exposes' : 'listens on'} port${svc.ports.length > 1 ? 's' : ''} ${svc.ports.join(', ')}.` : '';
  return `Kubernetes ${kind} ${name}.${image}${ports}`;
}

// ---------- Terraform ----------
const IDENT = '[A-Za-z_][A-Za-z0-9_-]*';
const REF_RE = new RegExp(`(?<![\\w.-])([a-z][a-z0-9_]*)\\.(${IDENT})`, 'g');

/** Blanks comments, the bodies of heredocs, and braces inside strings, keeping every newline, so blocks can be matched by braces. */
function maskHcl(text) {
  const src = text.replace(/\r\n/g, '\n');
  let out = '';
  let i = 0;
  const blank = (str) => str.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === '#' || two === '//') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; out += blank(src.slice(i, end)); i = end; continue; }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; out += blank(src.slice(i, end)); i = end; continue; }
    const hd = /^<<-?\s*"?([A-Za-z_][\w]*)"?[^\n]*\n/.exec(src.slice(i, i + 200));
    if (hd) {
      const marker = new RegExp(`\\n[ \\t]*${hd[1]}[ \\t]*(?=\\n|$)`).exec(src.slice(i + hd[0].length - 1));
      const end = marker ? i + hd[0].length - 1 + marker.index + marker[0].length : src.length;
      out += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1).replace(/[{}]/g, ' ');
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * `resource "type" "name" { ... }` blocks and the references between them. A reference is `type.name` (optionally followed by
 * attributes) appearing inside another resource's block; it is kept only when that resource is declared in the repository.
 * `data.`, `var.`, `local.`, `module.` and the like never match a resource, so they are never linked.
 */
function terraformServices(paths, read) {
  const resources = [];
  for (const file of paths) {
    if (!TERRAFORM_RE.test(file) || /(^|\/)\.terraform\//.test(file) || file.split('/').length > 6) continue;
    const text = read(file);
    if (!text || text.length > MAX_INFRA_FILE) continue;
    const masked = maskHcl(text);
    const lineAt = (idx) => masked.slice(0, idx).split('\n').length;
    const head = new RegExp(`^[ \\t]*resource[ \\t]+"([A-Za-z0-9_]+)"[ \\t]+"(${IDENT})"[ \\t]*\\{`, 'gm');
    let m;
    while ((m = head.exec(masked))) {
      let depth = 1, j = head.lastIndex;
      while (j < masked.length && depth > 0) { if (masked[j] === '{') depth++; else if (masked[j] === '}') depth--; j++; }
      if (depth !== 0) continue; // an unterminated block is ignored rather than guessed at
      head.lastIndex = j;
      resources.push({ type: m[1], rname: m[2], file, line: lineAt(m.index + m[0].indexOf('resource')), endLine: lineAt(j - 1), body: masked.slice(m.index + m[0].length, j - 1), bodyStartLine: lineAt(m.index + m[0].length) });
    }
  }
  const byName = new Map();
  for (const r of resources) if (!byName.has(`${r.type}.${r.rname}`)) byName.set(`${r.type}.${r.rname}`, r);
  const out = [];
  for (const [name, r] of byName) {
    const deps = [];
    const lines = r.body.split('\n');
    lines.forEach((ln, i) => {
      for (const m of ln.matchAll(REF_RE)) {
        const target = `${m[1]}.${m[2]}`;
        if (target === name || !byName.has(target) || deps.some((d) => d.name === target)) continue;
        const lineNo = r.bodyStartLine + i;
        deps.push({ name: target, line: lineNo, kind: 'references', label: 'references', summary: `${name} refers to ${target} (line ${lineNo}).` });
      }
    });
    out.push({ name, file: r.file, line: r.line, endLine: r.endLine, tech: 'Terraform', role: r.type, image: null, build: null, ports: [], dependsOn: deps, summary: `Terraform resource ${name} of type ${r.type}.` });
  }
  return out;
}
