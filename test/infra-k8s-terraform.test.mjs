// Infrastructure view, part two: Kubernetes manifests (#54) and Terraform resources (#55), on top of the Compose reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { parseYamlDocs } from '../skills/repo-architecture/scripts/lib/core/yaml-lite.mjs';
import { extractInfra, k8sCandidates } from '../skills/repo-architecture/scripts/lib/core/infra-core.mjs';
import { analyzeRepo } from '../skills/repo-architecture/scripts/lib/web/github-loader.mjs';
import { repo } from './helpers.mjs';

const K8S = [
  'apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: web', 'spec:', '  template:', '    metadata:', '      labels:', '        app: web', '        tier: front',
  '    spec:', '      containers:', '      - name: web', '        image: nginx:1.25', '        ports:', '        - containerPort: 80',
  '---', '# the service', 'apiVersion: v1', 'kind: Service', 'metadata:', '  name: web', 'spec:', '  selector:', '    app: web', '  ports:', '  - port: 80',
  '---', 'apiVersion: v1', 'kind: Service', 'metadata:', '  name: lonely', 'spec:', '  selector:', '    app: web', '    tier: back', // no workload has tier=back
  '---', 'apiVersion: v1', 'kind: Service', 'metadata:', '  name: empty', 'spec:', '  selector: {}',
  '---', 'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: edge', 'spec:', '  rules:', '  - host: shop.example.com', '    http:', '      paths:',
  '      - path: /', '        backend:', '          service:', '            name: web', '            port:', '              number: 80',
  '      - path: /x', '        backend:', '          service:', '            name: ghost', '',
].join('\n');

const by = (infra) => Object.fromEntries(infra.services.map((s) => [s.name, s]));

test('yaml: a multi-document stream keeps every document\'s real line numbers', () => {
  const docs = parseYamlDocs(K8S);
  assert.deepEqual(docs.map((d) => d.value.kind), ['Deployment', 'Service', 'Service', 'Service', 'Ingress']);
  assert.deepEqual([docs[0].start, docs[0].end, docs[1].start], [1, 16, 19], 'a leading comment is not part of a document');
  assert.equal(docs[1].value.$lines.kind, 20);
  assert.deepEqual(parseYamlDocs('').length, 0);
  assert.doesNotThrow(() => parseYamlDocs('---\n---\n- :\n---\na: [\n'));
});

test('k8s: workloads, selector matches and ingress routes, each with its file and line; ambiguity stays unlinked', () => {
  const infra = extractInfra(['k8s/app.yaml'], () => K8S);
  const s = by(infra);
  assert.deepEqual(Object.keys(s), ['Deployment/web', 'Service/web', 'Service/lonely', 'Service/empty', 'Ingress/edge']);
  assert.equal(s['Deployment/web'].image, 'nginx:1.25');
  assert.deepEqual(s['Deployment/web'].ports, ['80']);
  assert.equal(s['Deployment/web'].tech, 'Kubernetes');
  assert.deepEqual([s['Service/web'].line, s['Service/web'].endLine], [19, 27]);
  assert.deepEqual(s['Service/web'].dependsOn.map((d) => [d.name, d.line, d.kind]), [['Deployment/web', 25, 'routes']], 'a selector with app=web matches');
  assert.deepEqual(s['Service/lonely'].dependsOn, [], 'a selector that matches nothing links to nothing (all keys must match)');
  assert.deepEqual(s['Service/empty'].dependsOn, [], 'an empty selector selects nothing');
  assert.deepEqual(s['Ingress/edge'].dependsOn.map((d) => [d.name, d.line]), [['Service/web', 57]], 'the ghost backend does not exist and is dropped');
});

test('k8s: namespaces are respected, unrelated yaml and templated files are ignored', () => {
  const mk = (ns, kind, extra) => `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: api\n  namespace: ${ns}\nspec:\n${extra}\n`;
  const dep = (ns) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n  namespace: ${ns}\nspec:\n  template:\n    metadata:\n      labels:\n        app: api\n`;
  const files = { 'a/dep.yaml': dep('prod'), 'a/svc.yaml': mk('staging', 'Service', '  selector:\n    app: api'), 'a/tpl.yaml': '{{ define "x" }}\napiVersion: v1\nkind: Service\nmetadata:\n  name: t\n', 'ci.yml': 'name: ci\non: push\n', 'a/data.yaml': 'kind: Thing\n' };
  const s = by(extractInfra(Object.keys(files), (p) => files[p]));
  assert.deepEqual(Object.keys(s), ['prod/Deployment/api', 'staging/Service/api']);
  assert.deepEqual(s['staging/Service/api'].dependsOn, [], 'a Service does not select workloads of another namespace');
});

const TF = [
  '# resource "aws_fake" "commented" {}', 'resource "aws_vpc" "main" {', '  cidr_block = var.cidr', '  tags = { Url = "http://x/{y}" }', '}', '',
  'resource "aws_subnet" "a" {', '  vpc_id = "${aws_vpc.main.id}" # aws_ghost.c', '}', '',
  'resource "aws_lb" "web" {', '  name    = "web"', '  subnets = [aws_subnet.a.id, aws_subnet.nope.id]', '}', '',
  'resource "aws_lb_listener" "http" {', '  load_balancer_arn = aws_lb.web.arn', '  vpc = data.aws_vpc.other.id', '  user_data = <<-EOT', '    aws_vpc.main }', '  EOT', '  depends_on = [aws_subnet.a]', '}', '',
].join('\n');

test('terraform: resources with line ranges and exact type.name references; unknown, data, var and heredoc text never link', () => {
  const s = by(extractInfra(['infra/main.tf'], () => TF));
  assert.deepEqual(Object.keys(s), ['aws_vpc.main', 'aws_subnet.a', 'aws_lb.web', 'aws_lb_listener.http']);
  assert.deepEqual([s['aws_vpc.main'].line, s['aws_vpc.main'].endLine], [2, 5]);
  assert.equal(s['aws_vpc.main'].role, 'aws_vpc');
  assert.deepEqual(s['aws_vpc.main'].dependsOn, [], 'var.cidr is not a resource');
  assert.deepEqual(s['aws_subnet.a'].dependsOn.map((d) => [d.name, d.line]), [['aws_vpc.main', 8]], 'interpolation is read; the trailing comment is not');
  assert.deepEqual(s['aws_lb.web'].dependsOn.map((d) => [d.name, d.line]), [['aws_subnet.a', 13]], 'aws_subnet.nope is not declared');
  assert.deepEqual(s['aws_lb_listener.http'].dependsOn.map((d) => [d.name, d.line]), [['aws_lb.web', 17], ['aws_subnet.a', 22]], 'data. and heredoc text are ignored');
});

test('terraform: a malformed or unterminated file does not throw and is skipped', () => {
  for (const t of ['resource "a" "b" {', 'resource', '}}}', 'resource "a" "b" { x = "unterminated', '\0']) {
    assert.doesNotThrow(() => extractInfra(['x.tf'], () => t));
  }
  assert.deepEqual(extractInfra(['x.tf'], () => 'resource "a" "b" {').services, []);
  assert.deepEqual(extractInfra(['.terraform/modules/m/main.tf'], () => 'resource "a" "b" {}').services, []);
});

test('tour: Kubernetes and Terraform become infra components, edges with evidence, and an infrastructure flow that validates', () => {
  const root = repo({ 'package.json': '{"name":"x"}', 'main.js': 'console.log(1);\n', 'deploy/app.yaml': K8S, 'infra/main.tf': TF });
  const arch = generate(scanRepo(root));
  const infra = arch.nodes.filter((n) => n.kind === 'infra');
  assert.equal(infra.length, 5 + 4);
  assert.ok(infra.some((n) => n.label === 'Deployment/web' && n.tech[0] === 'Kubernetes' && /nginx:1\.25/.test(n.summary)));
  assert.ok(infra.some((n) => n.label === 'aws_lb.web' && n.tech[0] === 'Terraform'));
  const routes = arch.edges.filter((e) => e.kind === 'routes');
  assert.deepEqual(routes.map((e) => e.label).sort(), ['routes to', 'selects']);
  const refs = arch.edges.filter((e) => e.kind === 'references');
  assert.equal(refs.length, 4);
  assert.ok([...routes, ...refs].every((e) => e.sources[0].lines[0] >= 1 && /\.(yaml|tf)$/.test(e.sources[0].path)));
  const flow = arch.flows.find((f) => f.id === 'infrastructure');
  assert.ok(flow && flow.steps.some((s) => /Kubernetes/.test(s.title)) && flow.steps.some((s) => /Terraform/.test(s.title)));
  assert.equal(new Set(flow.steps.map((s) => s.id)).size, flow.steps.length, 'step ids are unique');
  assert.deepEqual(validate(arch, root).errors, []);
});

test('k8s candidates: conventional folders first, workflows and compose files never', () => {
  const picks = k8sCandidates(['z/a.yaml', 'k8s/b.yaml', '.github/workflows/ci.yml', 'docker-compose.yml', 'x.yaml', 'deep/a/b/c/d/e/f.yaml', 'values.yaml', 'chart/Chart.yaml']);
  assert.deepEqual(picks, ['k8s/b.yaml', 'x.yaml', 'z/a.yaml']);
});

test('website loader: downloads Terraform files and likely manifests, so the browser gets the same infrastructure view', async () => {
  const files = { 'k8s/app.yaml': K8S, 'main.tf': TF, 'web/index.js': '1;\n', 'package.json': '{"name":"x"}', '.github/workflows/ci.yml': 'name: ci\n' };
  const fetched = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'api.github.com') {
      if (/\/commits\//.test(u.pathname)) return new Response('e'.repeat(40));
      return new Response(JSON.stringify({ truncated: false, tree: Object.keys(files).map((p) => ({ path: p, type: 'blob', size: files[p].length })) }));
    }
    const p = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
    fetched.push(p);
    return files[p] != null ? new Response(files[p]) : new Response('', { status: 404 });
  };
  const r = await analyzeRepo({ owner: 'o', repo: 'r', ref: null }, { fetchImpl });
  assert.ok(fetched.includes('k8s/app.yaml') && fetched.includes('main.tf'));
  assert.ok(!fetched.includes('.github/workflows/ci.yml'));
  assert.ok(r.arch.nodes.some((n) => n.label === 'Service/web') && r.arch.nodes.some((n) => n.label === 'aws_lb.web'));
  assert.deepEqual(r.validation.errors, []);
});
