// The CPU-bound middle of loading a repository from GitHub: turning the file tree into "which files do we download".
//   readTree  : parse the tree response, keep the files, sort their paths (a large repository has thousands of entries)
//   planSources: apply .gitignore, then choose manifests, Docker / Terraform / Kubernetes / data-model / API files and source files
// Both are pure functions of plain data, so they run unchanged on the main thread (tests, Node, a browser without module workers)
// or in the analysis Web Worker, where they keep a large repository from freezing the page and stalling the progress bar.
import { makeIgnorer, filterPaths, UNIT_EXT, TEST_RE, extOf } from '../core/scan-core.mjs';
import { isExamplePath, TOOLING_RE } from '../generate.mjs';
import { PLUGIN_MANIFEST_SRC } from '../core/languages.mjs';
import { COMPOSE_RE, TERRAFORM_RE, k8sCandidates } from '../core/infra-core.mjs';
import { DATA_FILE_RE } from '../core/data-core.mjs';
import { OPENAPI_RE } from '../core/http-core.mjs';
import { GRAPHQL_FILE_RE } from '../core/graphql-core.mjs';

export const MAX_FILE_BYTES = 512 * 1024;

// Small files the scanner reads besides source: dependency manifests, workspace definitions, and the configs that
// define import aliases (tsconfig/jsconfig paths, Vite and webpack aliases).
const MANIFEST_RE = new RegExp('(^|/)(package\\.json|requirements[^/]*\\.txt|pyproject\\.toml|go\\.mod|go\\.work|pnpm-workspace\\.yaml|(tsconfig|jsconfig)[^/]*\\.json|(vite|webpack)\\.config\\.[cm]?[jt]s|' + PLUGIN_MANIFEST_SRC + ')$');
const ENTRY_HINT = /(^|\/)(main|index|app|server|cli|__main__|manage|__init__)\.[a-z]+$/i;

/** Decides which source files to download: skip tests/examples/tooling, prefer shallow + entry-like files. */
export function pickSourceFiles(paths, sizes, maxFiles) {
  const skipped = { tests: 0, examples: 0, tooling: 0 };
  const candidates = [];
  for (const p of paths) {
    if (!UNIT_EXT.has(extOf(p)) || (sizes.get(p) || 0) > MAX_FILE_BYTES) continue;
    if (TEST_RE.test(p)) { skipped.tests++; continue; }
    if (isExamplePath(p)) { skipped.examples++; continue; }
    if (TOOLING_RE.test(p)) { skipped.tooling++; continue; }
    candidates.push(p);
  }
  const rank = (p) => (ENTRY_HINT.test(p) ? 0 : 1);
  candidates.sort((a, b) => a.split('/').length - b.split('/').length || rank(a) - rank(b) || a.localeCompare(b));
  return { chosen: candidates.slice(0, maxFiles), total: candidates.length, skipped };
}

/**
 * @param text  the body of GitHub's `git/trees/<sha>?recursive=1` response
 * @returns { truncated, allPaths (sorted), sizes: [[path, bytes]] }  (sizes is an array so it crosses a worker boundary cheaply)
 */
export function readTree(text) {
  const tree = JSON.parse(text);
  const blobs = (tree.tree || []).filter((t) => t.type === 'blob');
  return { truncated: !!tree.truncated, allPaths: blobs.map((b) => b.path).sort(), sizes: blobs.map((b) => [b.path, b.size || 0]) };
}

/**
 * @param input { allPaths, sizes: [[path, bytes]] | Map, ignoreText, sub, maxFiles }
 * @returns { paths, manifests, readme, chosen, total, skipped, viewFiles, scopeEmpty }
 *   paths      the files left after .gitignore and built-in exclusions
 *   chosen     the source files to analyse (with total and skipped counts)
 *   viewFiles  Docker Compose / Terraform / OpenAPI / GraphQL / data-model files and likely Kubernetes manifests
 */
export function planSources({ allPaths, sizes, ignoreText = null, sub = '', maxFiles = 300 }) {
  const sizeOf = sizes instanceof Map ? sizes : new Map(sizes);
  const paths = filterPaths(allPaths, makeIgnorer((ignoreText || '').split('\n')));
  // Manifests and configs: shallow ones everywhere, plus package.json up to five levels deep (monorepo packages).
  const manifests = paths.filter((p) => MANIFEST_RE.test(p) && p.split('/').length <= (/(^|\/)package\.json$/.test(p) ? 5 : 3)).slice(0, 150);
  const readme = paths.find((p) => /^readme(\.md|\.rst|\.txt)?$/i.test(p)) || null;
  const inScope = sub ? paths.filter((p) => p.startsWith(sub + '/')) : paths;
  if (sub && !inScope.length) return { paths, manifests, readme, chosen: [], total: 0, skipped: { tests: 0, examples: 0, tooling: 0 }, viewFiles: [], scopeEmpty: true };
  const picked = pickSourceFiles(inScope, sizeOf, maxFiles);
  const small = (p) => (sizeOf.get(p) || 0) <= MAX_FILE_BYTES;
  // Docker Compose files, Terraform files, Kubernetes manifests (YAML in the folders they usually live in, then the shallowest; whether one
  // is a manifest is decided from its content), SQL / Prisma / Django schemas, OpenAPI documents and GraphQL (.graphql / .gql) documents feed the infrastructure, data-model and request-tracing views.
  const viewFiles = [
    ...inScope.filter((p) => (COMPOSE_RE.test(p) || TERRAFORM_RE.test(p) || DATA_FILE_RE.test(p) || OPENAPI_RE.test(p) || GRAPHQL_FILE_RE.test(p)) && !/(^|\/)\.terraform\//.test(p) && p.split('/').length <= 6 && small(p)).slice(0, 40),
    ...k8sCandidates(inScope.filter(small), 40),
  ];
  return { paths, manifests, readme, chosen: picked.chosen, total: picked.total, skipped: picked.skipped, viewFiles, scopeEmpty: false };
}
