// The infrastructure view (Docker Compose) and the data-model view (SQL, Prisma), plus the small YAML reader behind the first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { parseYaml } from '../skills/repo-architecture/scripts/lib/core/yaml-lite.mjs';
import { extractInfra } from '../skills/repo-architecture/scripts/lib/core/infra-core.mjs';
import { parseSql, parsePrisma, extractDataModel } from '../skills/repo-architecture/scripts/lib/core/data-core.mjs';
import { analyzeRepo } from '../skills/repo-architecture/scripts/lib/web/github-loader.mjs';
import { repo } from './helpers.mjs';

test('yaml-lite: mappings, lists, flow collections, quotes, comments and block scalars, with line numbers', () => {
  const d = parseYaml([
    '# comment', 'name: "demo app" # trailing', 'list:', '  - a', '  - "b # not a comment"', '  - c: 1', '    d: [x, y]',
    'flow: {k: v, n: 3}', 'text: |', '  keep', '  skipping', 'last: true', 'empty:', 'same:', '- x',
  ].join('\n'));
  assert.equal(d.name, 'demo app');
  assert.equal(d.list[0], 'a');
  assert.equal(d.list[1], 'b # not a comment');
  assert.deepEqual(JSON.parse(JSON.stringify(d.list[2])), { c: 1, d: ['x', 'y'] });
  assert.deepEqual(JSON.parse(JSON.stringify(d.flow)), { k: 'v', n: 3 });
  assert.equal(d.text, '');
  assert.equal(d.last, true);
  assert.equal(d.empty, null);
  assert.deepEqual([d.$lines.name, d.$lines.list, d.$lines.flow, d.$lines.last], [2, 3, 8, 12]);
  assert.deepEqual(d.list.$lines, [4, 5, 6]);
  assert.deepEqual(d.same, ['x'], 'a list at the same indent as its key');
});

test('yaml-lite: never throws or hangs on odd input', () => {
  for (const s of ['', '   ', '\t\t', ':::', '- - - -', 'a: [unclosed', '{{{', 'key: "unterminated', '\0\0', 'a:\n\tb: 1', 'x'.repeat(100000), '- a\nb: 1\n- c']) {
    assert.doesNotThrow(() => parseYaml(s), JSON.stringify(s.slice(0, 20)));
  }
});

const COMPOSE = [
  'services:', '  web:', '    build: ./web', '    ports:', '      - "8080:80"', '    depends_on:', '      - api', '  api:', '    build:', '      context: ./api', '    depends_on:', '      db:', '        condition: service_healthy',
  '  db:', '    image: postgres:16', '  worker:', '    image: alpine', '    depends_on: [db, ghost]', '',
].join('\n');

test('infra: compose services, dependencies and build contexts, each with the line they came from', () => {
  const infra = extractInfra(['docker-compose.yml', 'web/x.js'], () => COMPOSE);
  const by = Object.fromEntries(infra.services.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by), ['web', 'api', 'db', 'worker']);
  assert.equal(by.web.line, 2);
  assert.equal(by.web.build.dir, 'web');
  assert.equal(by.api.build.dir, 'api');
  assert.deepEqual(by.web.dependsOn, [{ name: 'api', line: 7 }]);
  assert.deepEqual(by.api.dependsOn, [{ name: 'db', line: 12 }], 'map form of depends_on');
  assert.deepEqual(by.worker.dependsOn.map((d) => d.name), ['db', 'ghost'], 'flow form of depends_on');
  assert.equal(by.db.image, 'postgres:16');
  assert.deepEqual(by.web.ports, ['8080:80']);
  assert.deepEqual(extractInfra(['a/b/c/d/e/docker-compose.yml'], () => COMPOSE).services, [], 'deeply nested files are ignored');
  assert.deepEqual(extractInfra(['docker-compose.yml'], () => 'not: compose').services, []);
});

test('infra: a generated tour with services, depends_on edges, links to the code they are built from, and validated evidence', () => {
  const root = repo({
    'docker-compose.yml': COMPOSE,
    'package.json': '{"name":"shop"}',
    'web/index.js': "import { x } from './x.js';\nconsole.log(x);\n",
    'web/x.js': 'export const x = 1;\n',
    'api/server.js': "import { db } from './db.js';\nconsole.log(db);\n",
    'api/db.js': 'export const db = 1;\n',
  });
  const arch = generate(scanRepo(root), { maxNodes: 4 });
  const svc = arch.nodes.filter((n) => n.kind === 'infra');
  assert.deepEqual(svc.map((n) => n.label).sort(), ['api', 'db', 'web', 'worker']);
  const web = svc.find((n) => n.label === 'web');
  assert.deepEqual(web.sources[0].path, 'docker-compose.yml');
  assert.equal(web.sources[0].lines[0], 2);
  const dep = arch.edges.filter((e) => e.kind === 'depends');
  assert.equal(dep.length, 3, 'web->api, api->db, worker->db (ghost does not exist and is dropped)');
  assert.ok(dep.every((e) => e.sources[0].path === 'docker-compose.yml' && e.sources[0].lines[0] >= 2));
  const builds = arch.edges.filter((e) => e.kind === 'builds');
  assert.ok(builds.length >= 2, 'web and api are linked to their code');
  assert.ok(builds.every((e) => svc.some((n) => n.id === e.from) && arch.nodes.some((n) => n.id === e.to && n.kind !== 'infra')));
  const flow = arch.flows.find((f) => f.id === 'infrastructure');
  assert.ok(flow && flow.steps.length >= 3);
  assert.match(flow.steps[1].narration, /db.*no dependencies|no dependencies/i, 'the start order begins with what depends on nothing');
  assert.deepEqual(validate(arch, root).errors, []);
});

test('infra: a dependency cycle does not hang the generator', () => {
  const cyc = 'services:\n  a:\n    image: x\n    depends_on: [b]\n  b:\n    image: y\n    depends_on: [a]\n';
  const root = repo({ 'compose.yaml': cyc, 'main.js': "console.log(1);\n" });
  const arch = generate(scanRepo(root));
  assert.equal(arch.nodes.filter((n) => n.kind === 'infra').length, 2);
  assert.deepEqual(validate(arch, root).errors, []);
});

const SQL = [
  '-- CREATE TABLE ghost (id int);', 'CREATE TABLE users (', '  id SERIAL PRIMARY KEY,', '  email VARCHAR(255) NOT NULL UNIQUE, -- login', '  created_at TIMESTAMP DEFAULT now()', ');',
  '/* CREATE TABLE hidden (id int); */', 'CREATE TABLE IF NOT EXISTS public."orders" (', '  id BIGINT PRIMARY KEY,', '  user_id INT NOT NULL REFERENCES users(id),', '  total NUMERIC(10,2),',
  '  ship_id INT,', '  CONSTRAINT fk_ship FOREIGN KEY (ship_id) REFERENCES shipments (id)', ');', 'CREATE TABLE shipments (id int primary key, note text);', 'CREATE TABLE broken (id int', '',
].join('\n');

test('data: SQL tables, columns and foreign keys, ignoring comments, quoting and broken statements', () => {
  const e = parseSql('db/schema.sql', SQL);
  assert.deepEqual(e.map((x) => x.name), ['users', 'orders', 'shipments'], 'no ghost, no hidden, and the unbalanced one is skipped');
  const users = e[0];
  assert.deepEqual([users.line, users.endLine], [2, 6]);
  assert.deepEqual(users.columns.map((c) => c.name), ['id', 'email', 'created_at']);
  const orders = e[1];
  assert.deepEqual(orders.columns.map((c) => c.name), ['id', 'user_id', 'total', 'ship_id']);
  assert.deepEqual(orders.refs.map((r) => [r.to, r.column, r.line]).sort(), [['shipments', 'ship_id', 13], ['users', 'user_id', 10]]);
});

test('data: Prisma models, relation fields and foreign keys', () => {
  const m = parsePrisma('prisma/schema.prisma', 'model User {\n  id Int @id\n  email String @unique\n  posts Post[]\n}\nmodel Post {\n  id Int @id\n  author User @relation(fields: [authorId], references: [id])\n  authorId Int\n}\n');
  assert.deepEqual(m.map((x) => x.name), ['User', 'Post']);
  assert.deepEqual(m[0].columns.map((c) => c.name), ['id', 'email'], 'a relation field is not a stored column');
  assert.deepEqual(m[1].refs, [{ to: 'User', column: 'author', line: 8 }]);
});

test('data: a generated tour with tables, foreign-key edges pointing at the lines, and validated evidence', () => {
  const root = repo({
    'db/schema.sql': SQL,
    'prisma/schema.prisma': 'model A {\n  id Int @id\n  b B @relation(fields: [bId], references: [id])\n  bId Int\n}\nmodel B {\n  id Int @id\n}\n',
    'app.js': "console.log('app');\n",
  });
  const scan = scanRepo(root);
  assert.equal(scan.dataModel.entities.length, 5);
  const arch = generate(scan);
  const ents = arch.nodes.filter((n) => n.kind === 'entity');
  assert.deepEqual(ents.map((n) => n.label).sort(), ['A', 'B', 'orders', 'shipments', 'users']);
  const refs = arch.edges.filter((e) => e.kind === 'references');
  assert.equal(refs.length, 3);
  const o2u = refs.find((e) => /orders holds a foreign key \(user_id\) to users/.test(e.summary));
  assert.deepEqual(o2u.sources[0], { path: 'db/schema.sql', lines: [10, 10] });
  const flow = arch.flows.find((f) => f.id === 'data-model');
  assert.ok(flow && flow.steps.length >= 2);
  assert.deepEqual(validate(arch, root).errors, []);
});

test('data: hostile SQL and a huge schema stay bounded', () => {
  assert.doesNotThrow(() => parseSql('x.sql', 'CREATE TABLE ' + '('.repeat(5000)));
  assert.doesNotThrow(() => parsePrisma('x.prisma', 'model X {' + '{'.repeat(5000)));
  const many = Array.from({ length: 100 }, (_, i) => `CREATE TABLE t${i} (id int, p int REFERENCES t${(i + 1) % 100}(id));`).join('\n');
  const dm = extractDataModel(['big.sql'], () => many);
  assert.equal(dm.entities.length, 60, 'capped');
  const root = repo({ 'big.sql': many, 'a.js': '1;\n' });
  const arch = generate(scanRepo(root));
  assert.ok(arch.nodes.filter((n) => n.kind === 'entity').length <= 30);
  assert.deepEqual(validate(arch, root).errors, []);
});

test('views: nothing is added when there is no compose file or schema', () => {
  const root = repo({ 'a.js': "import './b.js';\n", 'b.js': '1;\n' });
  const arch = generate(scanRepo(root));
  assert.ok(!arch.nodes.some((n) => n.kind === 'infra' || n.kind === 'entity'));
  assert.ok(!arch.flows.some((f) => f.id === 'infrastructure' || f.id === 'data-model'));
});

test('website loader: downloads compose files and schemas, so the browser gets the same extra views', async () => {
  const files = { 'docker-compose.yml': COMPOSE, 'db/schema.sql': SQL, 'web/index.js': '1;\n', 'api/server.js': '1;\n', 'package.json': '{"name":"x"}' };
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
  assert.ok(fetched.includes('docker-compose.yml') && fetched.includes('db/schema.sql'));
  assert.ok(r.arch.nodes.some((n) => n.kind === 'infra') && r.arch.nodes.some((n) => n.kind === 'entity'));
  assert.deepEqual(r.validation.errors, []);
});

test('data: a migration history is one schema: duplicates collapse, the maintained schema wins, ALTER TABLE foreign keys count', () => {
  const files = {
    'db/migrations/001_init.sql': 'CREATE TABLE "User" (id int primary key);\nCREATE TABLE "Post" (id int primary key, "authorId" int);\n',
    'db/migrations/002_more.sql': 'CREATE TABLE "User" (id int primary key, extra text);\nALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE CASCADE;\n',
    'schema.sql': 'CREATE TABLE users (id int, name text);\nCREATE TABLE "User" (id int, email text, name text);\n',
  };
  const dm = extractDataModel(Object.keys(files), (p) => files[p]);
  assert.deepEqual(dm.entities.map((e) => e.name).sort(), ['Post', 'User', 'users']);
  const user = dm.entities.find((e) => e.name === 'User');
  assert.equal(user.file, 'schema.sql', 'the maintained schema beats the migration history');
  assert.deepEqual(user.columns.map((c) => c.name), ['id', 'email', 'name']);
  assert.equal(dm.relations.length, 1);
  assert.deepEqual([dm.relations[0].from.name, dm.relations[0].to.name, dm.relations[0].column, dm.relations[0].file, dm.relations[0].line], ['Post', 'User', 'authorId', 'db/migrations/002_more.sql', 2]);
});

test('data: a Prisma model wins over the SQL that was generated from it', () => {
  const files = {
    'prisma/schema.prisma': 'model User {\n  id Int @id\n}\n',
    'prisma/migrations/1/migration.sql': 'CREATE TABLE "User" (id int);\n',
  };
  const dm = extractDataModel(Object.keys(files), (p) => files[p]);
  assert.equal(dm.entities.length, 1);
  assert.equal(dm.entities[0].kind, 'model');
});
