#!/usr/bin/env node
// gitvisualise — turn any repository (local path or GitHub URL) into an interactive, narrated architecture site.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJSON, writeJSON, toPosix } from './lib/util.mjs';
import { scanRepo } from './lib/scan.mjs';
import { generate } from './lib/generate.mjs';
import { mergeArchitecture } from './lib/merge.mjs';
import { validate } from './lib/validate.mjs';
import { build } from './lib/build.mjs';
import { diffArchitectures } from './lib/core/diff-core.mjs';
import { EXPORT_FORMATS } from './lib/core/export-core.mjs';
import { parseTarget, ensureClone } from './lib/github.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const VIEWER_DIR = path.join(SKILL_DIR, 'viewer');

const HELP = `gitvisualise <command> [repo] [options]

  repo   local path (default ".") | https://github.com/owner/repo | owner/repo

Commands
  scan       Scan the repo and write facts to <repo>/.gitvisualise/scan.json (input for Claude / the generator)
  generate   Heuristically generate architecture.json and MERGE it into the existing one (manual/Claude edits kept)
  validate   Check architecture.json against the real repo (sources exist, lines in range, flows reference real nodes)
  build      Validate, then write index.html + viewer files next to architecture.json
  all        generate + validate + build
  serve      Serve the output folder locally (default http://localhost:4173)
  diff       Compare two architecture.json files (older, newer): marks components and relationships added / removed / changed
  export     Write an architecture.json as Mermaid or PlantUML text (--format mermaid|plantuml [--out file])
  install-skill   Copy this skill to ~/.claude/skills (or ./.claude/skills with --project)

Options
  --out <dir>        Output folder (default: <repo>/docs/architecture; for GitHub URLs: ./gitvisualise-out/<owner>__<repo>)
  --ref <ref>        Branch/tag to clone for GitHub URLs
  --path <dir>       Analyse one folder of a larger repository (a package of a monorepo); paths stay repo-relative
  --repo-url <url>   Override the GitHub URL used for "Open Source" links
  --max-nodes <n>    Target node count for the heuristic generator (default 14)
  --ignore a,b       Extra paths to skip while scanning
  --include a,b      Also diagram: tests, examples, tooling (skipped by default)
  --no-pin           Do not pin "Open Source" links to the current commit; link to the branch tip instead.
                     Use for a tour committed inside the repo it describes (it cannot know its own commit).
  --root <dir>       diff: the newer revision's checkout; validates the result against it and builds a page in --out
  --base-ref, --head-ref <name>   diff: labels for the two revisions (default: the file names)
  --force            Build even if validation reports errors
  --port <n>         Port for serve
`;

function resolveContext(positional, flags) {
  const t = parseTarget(positional[0]);
  let root, defaultOut;
  if (t.type === 'github') {
    console.log(`Cloning ${t.url}${flags.ref || t.ref ? ' @ ' + (flags.ref || t.ref) : ''} ...`);
    root = ensureClone(t, flags.ref);
    defaultOut = path.resolve('gitvisualise-out', `${t.owner}__${t.repo}`);
  } else {
    root = t.dir;
    if (!fs.existsSync(root)) throw new Error(`Not a directory: ${root}`);
    defaultOut = path.join(root, 'docs', 'architecture');
  }
  const outDir = path.resolve(flags.out || defaultOut);
  const rel = toPosix(path.relative(root, outDir));
  const ignore = [...(flags.ignore ? String(flags.ignore).split(',') : []), ...(!rel.startsWith('..') && rel ? [rel] : [])];
  return { root, outDir, ignore, repoUrl: flags['repo-url'] || (t.type === 'github' ? t.url : undefined), ref: flags.ref || t.ref, subPath: flags.path || t.path || undefined, name: t.type === 'github' ? t.repo : undefined, noPin: !!flags['no-pin'] };
}

const archFile = (ctx) => path.join(ctx.outDir, 'architecture.json');

function doScan(ctx) {
  const scan = scanRepo(ctx.root, { ignore: ctx.ignore, repoUrl: ctx.repoUrl, name: ctx.name, subPath: ctx.subPath });
  if (ctx.noPin) { scan.repo.commit = null; scan.repo.branch = null; delete scan.repo.dirty; } // links then point at the branch tip (HEAD)
  // Cache lives with the repo when the output is inside it, otherwise next to the output (never touches other folders).
  const inside = !path.relative(ctx.root, ctx.outDir).startsWith('..');
  const file = inside ? path.join(ctx.root, '.gitvisualise', 'scan.json') : path.join(ctx.outDir, 'scan.json');
  writeJSON(file, scan);
  console.log(`Scanned ${scan.stats.sourceFiles} source files (${scan.stats.files} total), ${scan.entryPoints.length} entry point(s), ${scan.externals.length} external dependencies.`);
  if (scan.workspaces.length) console.log(`Monorepo: ${scan.workspaces.length} packages (${scan.workspaces.slice(0, 6).map((w) => w.name).join(', ')}${scan.workspaces.length > 6 ? ', ...' : ''}). Use --path <dir> to analyse one.`);
  console.log(`Facts written to ${file}`);
  return scan;
}

function doGenerate(ctx, flags) {
  const scan = doScan(ctx);
  if (!scan.files.length) throw new Error('No source files found to diagram.');
  const generated = generate(scan, { maxNodes: flags['max-nodes'], include: flags.include });
  const existing = fs.existsSync(archFile(ctx)) ? readJSON(archFile(ctx)) : null;
  const { arch, report } = mergeArchitecture(existing, generated);
  writeJSON(archFile(ctx), arch);
  console.log(`Wrote ${archFile(ctx)} (${arch.nodes.length} nodes, ${arch.edges.length} edges, ${arch.flows.length} flows)`);
  if (existing) {
    console.log(`Merge: ${report.kept.length} owned item(s) preserved, ${report.partial.length} partially locked, ${report.added.length} added, ${report.dropped.length} dropped.`);
    report.dropped.forEach((d) => console.log(`  dropped (no longer in repo): ${d}`));
  }
  return arch;
}

function doValidate(ctx, quiet = false) {
  if (!fs.existsSync(archFile(ctx))) throw new Error(`No architecture.json at ${archFile(ctx)}. Run "generate" first.`);
  let arch;
  try { arch = readJSON(archFile(ctx)); } catch (e) { throw new Error(`architecture.json is not valid JSON: ${e.message}`); }
  const r = validate(arch, ctx.root);
  r.warnings.forEach((w) => console.log(`warning: ${w}`));
  r.errors.forEach((e) => console.log(`ERROR:   ${e}`));
  console.log(r.errors.length ? `\nValidation FAILED: ${r.errors.length} error(s), ${r.warnings.length} warning(s).` : `Validation passed: ${r.stats.nodes} nodes, ${r.stats.edges} edges, ${r.stats.flows} flows, ${r.stats.steps} steps (${r.warnings.length} warning(s)).`);
  return { arch, ...r };
}

function doBuild(ctx, flags) {
  const r = doValidate(ctx);
  if (r.errors.length && !flags.force) throw new Error('Refusing to build with validation errors (fix them, or pass --force).');
  const p = r.arch.project;
  if (p.repoUrl && p.commit) console.log(`note: "Open Source" links point at GitHub commit ${p.commit.slice(0, 7)}. Push that commit, or they will 404.` + (p.dirty ? ' The working tree had uncommitted changes when scanned, so line numbers may not match GitHub.' : ''));
  const b = build({ arch: r.arch, root: ctx.root, outDir: ctx.outDir, viewerDir: VIEWER_DIR });
  console.log(`Built ${path.join(ctx.outDir, 'index.html')} (${b.snippets} code snippets embedded).`);
}

function doExport(positional, flags) {
  const src = positional[0] || '.';
  const candidates = [src, path.join(src, 'architecture.json'), path.join(src, 'docs', 'architecture', 'architecture.json')];
  const file = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!file) throw new Error(`No architecture.json found at ${src}. Run "generate" first, or pass the file.`);
  const format = String(flags.format || 'mermaid').toLowerCase();
  if (!EXPORT_FORMATS[format]) throw new Error(`Unknown format "${format}". Use mermaid or plantuml.`);
  let arch;
  try { arch = readJSON(file); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
  if (!arch || !Array.isArray(arch.nodes) || !Array.isArray(arch.edges)) throw new Error(`${file} does not look like an architecture.json`);
  const text = EXPORT_FORMATS[format](arch, { direction: flags.direction === 'TB' ? 'TB' : 'LR' });
  if (flags.out) { fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true }); fs.writeFileSync(flags.out, text); console.log(`Wrote ${flags.out} (${arch.nodes.length} nodes, ${arch.edges.length} edges, ${format})`); }
  else process.stdout.write(text);
}

function doDiff(positional, flags) {
  if (positional.length !== 2) throw new Error('usage: gitvisualise diff <older architecture.json> <newer architecture.json> [--out <dir>] [--root <newer checkout>]');
  const load = (p) => {
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'architecture.json') : p;
    if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
    try { return readJSON(file); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
  };
  const [base, head] = positional.map(load);
  const { arch, summary } = diffArchitectures(base, head, {
    baseRef: flags['base-ref'] || path.basename(positional[0]), headRef: flags['head-ref'] || path.basename(positional[1]),
    baseCommit: base.project && base.project.commit, headCommit: head.project && head.project.commit,
  });
  const outDir = path.resolve(flags.out || 'gitvisualise-diff');
  const file = path.join(outDir, 'architecture.json');
  writeJSON(file, arch);
  const n = summary.nodes, e = summary.edges;
  console.log(summary.empty ? 'No structural differences.' : `Components: +${n.added} -${n.removed} ~${n.changed}   Relationships: +${e.added} -${e.removed} ~${e.changed}`);
  console.log(`Wrote ${file}`);
  if (flags.root) {
    const r = validate(arch, path.resolve(flags.root));
    r.errors.forEach((x) => console.log(`ERROR:   ${x}`));
    if (r.errors.length && !flags.force) throw new Error('The comparison does not validate against --root (pass --force to build anyway).');
    const b = build({ arch, root: path.resolve(flags.root), outDir, viewerDir: VIEWER_DIR });
    console.log(`Built ${path.join(outDir, 'index.html')} (${b.snippets} code snippets embedded).`);
  }
}

function serve(dir, port) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript','.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(dir, path.normalize(p));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, () => console.log(`Serving ${dir}\n  http://localhost:${port}/  (Ctrl+C to stop)`));
}

function installSkill(flags) {
  const dest = flags.project ? path.resolve('.claude', 'skills', 'repo-architecture') : path.join(os.homedir(), '.claude', 'skills', 'repo-architecture');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(SKILL_DIR, dest, { recursive: true });
  console.log(`Installed skill to ${dest}\nIn Claude Code, say: "Generate an interactive architecture for this project"`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const cmd = positional.shift();
try {
  if (!cmd || cmd === 'help' || flags.help) console.log(HELP);
  else if (cmd === 'install-skill') installSkill(flags);
  else if (cmd === 'diff') doDiff(positional, flags);
  else if (cmd === 'export') doExport(positional, flags);
  else {
    const ctx = resolveContext(positional, flags);
    if (cmd === 'scan') doScan(ctx);
    else if (cmd === 'generate') doGenerate(ctx, flags);
    else if (cmd === 'validate') { if (doValidate(ctx).errors.length) process.exitCode = 1; }
    else if (cmd === 'build') doBuild(ctx, flags);
    else if (cmd === 'all') { doGenerate(ctx, flags); doBuild(ctx, flags); }
    else if (cmd === 'serve') serve(ctx.outDir, Number(flags.port) || 4173);
    else { console.log(`Unknown command "${cmd}"\n`); console.log(HELP); process.exitCode = 1; }
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
