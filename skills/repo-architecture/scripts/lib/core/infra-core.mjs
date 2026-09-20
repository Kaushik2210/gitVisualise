// Infrastructure view: the services a Docker Compose file declares, how they depend on each other, and which directory of the
// repository each one is built from. Every service and every dependency carries the file and line it was read from, exactly
// like a component found in code. Kubernetes and Terraform are not read yet.
import * as posix from './posix.mjs';
import { parseYaml } from './yaml-lite.mjs';
import { countLines } from './text.mjs';

/** Compose file names: docker-compose.yml, docker-compose.prod.yaml, compose.yml, compose.override.yaml ... */
export const COMPOSE_RE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;

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
  return { services: services.slice(0, 40) };
}
