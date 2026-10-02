// Request tracing for GraphQL (#56): client operations -> schema fields -> resolver maps, linked only when every step is exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGraphql, parseGraphqlDocument, resolverKeys, templateDocuments } from '../skills/repo-architecture/scripts/lib/core/graphql-core.mjs';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { analyzeRepo } from '../skills/repo-architecture/scripts/lib/web/github-loader.mjs';
import { repo } from './helpers.mjs';

const SCHEMA = [
  '# type Query { commented: Int }', '"""type Query { described: Int }"""', 'type Query {', '  "all users"', '  users(first: Int = 10, where: {a: 1}): [User!]!',
  '  user(id: ID!): User @deprecated(reason: "type Query { x: Int }")', '  orphan: Int', '  twice: Int', '  nope: Int', '}', 'extend type Query { twice: Int }',
  'type Mutation {', '  addUser(name: String!): User', '}', 'type User { id: ID! name: String }', 'scalar Date', '',
].join('\n');
const OPS = [
  'query Users($n: Int) {', '  list: users(first: $n) { id ...Frag }', '  user(id: 1) { name }', '  orphan', '  twice', '  ghost', '  ... on Query { nope }', '}',
  'mutation AddUser { addUser(name: "x") { id } }', '{ users }', 'fragment Frag on User { users: name }', '',
].join('\n');
const RESOLVERS = [
  "import x from 'y';", 'export const resolvers = {', '  Query: {', '    users: async () => [],', '    async user(_, { id }) { return { id, inner: { orphan: 1 } }; },', '    ...others,',
  '    [computed]: 1,', "    'twice': () => 1,", '    nope() {},', '  },', '  Mutation: { addUser(_, a) { return a; } },', "  User: { name: () => 'x' },", '};', '',
].join('\n');

const summarize = (links) => links.map((l) => `${l.kind} ${l.field}  ${l.client.file}:${l.client.line}  ${l.schema.file}:${l.schema.line}  ${l.resolver.file}:${l.resolver.line}`);

test('graphql: operations are linked to the schema field and the resolver, with a line on every side', () => {
  const { links } = extractGraphql([{ file: 'schema.graphql', text: SCHEMA }, { file: 'ops.graphql', text: OPS }], [{ file: 'src/resolvers.js', text: RESOLVERS }]);
  assert.deepEqual(summarize(links), [
    'query users  ops.graphql:2  schema.graphql:5  src/resolvers.js:4', // an alias still names the real field
    'query user  ops.graphql:3  schema.graphql:6  src/resolvers.js:5',
    'mutation addUser  ops.graphql:9  schema.graphql:13  src/resolvers.js:11',
    'query users  ops.graphql:10  schema.graphql:5  src/resolvers.js:4', // the anonymous `{ users }` shorthand is a query
  ]);
  assert.deepEqual(links.map((l) => l.operation), ['Users', 'Users', 'AddUser', null]);
});

test('graphql: ambiguity stays unlinked (duplicate schema fields, missing sides, nested or fragment selections, dynamic resolver keys)', () => {
  const { links } = extractGraphql([{ file: 'schema.graphql', text: SCHEMA }, { file: 'ops.graphql', text: OPS }], [{ file: 'src/resolvers.js', text: RESOLVERS }]);
  const fields = links.map((l) => l.field);
  assert.ok(!fields.includes('orphan'), 'declared in the schema, but no resolver key (a nested key named orphan is not a resolver)');
  assert.ok(!fields.includes('twice'), 'declared twice in the schema (type + extend), so which one is meant is unknown');
  assert.ok(!fields.includes('ghost'), 'not in the schema at all');
  assert.ok(!fields.includes('nope'), 'only reachable through `... on Query { nope }`, not a root selection');
  // two files implementing the same field: neither is chosen
  const both = extractGraphql([{ file: 's.graphql', text: 'type Query { a: Int }' }, { file: 'o.graphql', text: 'query { a }' }], [{ file: 'x.js', text: 'export default { Query: { a() {} } }' }, { file: 'y.js', text: 'export const resolvers = { Query: { a: 1 } }' }]);
  assert.deepEqual(both.links, []);
  // a resolver map that is not assigned / exported / passed as resolvers is not a resolver map
  assert.deepEqual(resolverKeys('foo({ Query: { a() {} } });\nconst z = { Query: { b() {} } };'), [{ type: 'Query', name: 'b', line: 2 }]);
  assert.deepEqual(resolverKeys('function f() { call(); return { Query: { c() {} } }; }').map((k) => k.name), ['c']);
  // the same field name under a different type is not a Query field
  assert.deepEqual(extractGraphql([{ file: 's.graphql', text: 'type Query { a: Int } type Other { b: Int }' }, { file: 'o.graphql', text: 'query { b }' }], [{ file: 'x.js', text: 'export default { Query: { b() {} }, Other: { b() {} } }' }]).links, []);
});

test('graphql: documents inside gql`` templates are read, with real line numbers, and ${fragments} are blanked', () => {
  const server = ['const typeDefs = gql`', '  type Query {', '    hello: String', '  }', '`;', 'export const resolvers = { Query: { hello: () => "hi" } };', ''].join('\n');
  const client = ['import { gql } from "apollo";', 'const FRAG = gql`fragment F on Query { hello }`;', 'export const Q = gql`', '  query H {', '    hello', '    ...F', '  }', '  ${FRAG}', '`;', ''].join('\n');
  const { links } = extractGraphql([], [{ file: 'server.js', text: server }, { file: 'client.js', text: client }]);
  assert.deepEqual(summarize(links), ['query hello  client.js:5  server.js:3  server.js:6']);
  assert.equal(templateDocuments('const a = 1;').length, 0);
});

test('graphql: renamed root types, odd input and unterminated blocks never throw', () => {
  const s = 'schema { query: RootQuery mutation: RootMutation }\ntype RootQuery { a: Int }\ntype RootMutation { m: Int }';
  const { links } = extractGraphql([{ file: 's.graphql', text: s }, { file: 'o.graphql', text: 'query { a }\nmutation { m }' }], [{ file: 'r.js', text: 'export const resolvers = { RootQuery: { a() {} }, RootMutation: { m() {} } };' }]);
  assert.deepEqual(links.map((l) => `${l.kind}:${l.field}`), ['query:a', 'mutation:m']);
  for (const t of ['', '{', 'type Query {', 'query ( { ', '"""', 'type Query { a(: Int }', '}}}{{{', '\0', 'schema { query: }', 'x'.repeat(5000)]) {
    assert.doesNotThrow(() => parseGraphqlDocument(t), JSON.stringify(t.slice(0, 20)));
    assert.doesNotThrow(() => resolverKeys(t));
    assert.doesNotThrow(() => extractGraphql([{ file: 'a.graphql', text: t }], [{ file: 'a.js', text: t }]));
  }
});

const FILES = {
  'package.json': '{"name":"app","main":"server/index.js"}',
  'schema.graphql': SCHEMA,
  'web/api.graphql': 'query Users { users { id } }\n',
  'web/app.js': "import { gql } from '@apollo/client';\nexport const ME = gql`\n  query Me {\n    user(id: 1) { name }\n  }\n`;\nconsole.log(ME);\n",
  'server/index.js': "import { resolvers } from './resolvers.js';\nconsole.log(resolvers);\n",
  'server/resolvers.js': RESOLVERS,
};

test('tour: a GraphQL link becomes an http edge from the client to the resolver file, citing the client, the schema and the resolver, and it validates', () => {
  const root = repo(FILES);
  const arch = generate(scanRepo(root));
  const gql = arch.edges.filter((e) => e.kind === 'http');
  assert.ok(gql.length >= 1, JSON.stringify(arch.edges.map((e) => [e.kind, e.label])));
  const edge = gql.find((e) => /user/.test(e.label));
  assert.ok(edge, JSON.stringify(gql.map((e) => e.label)));
  const to = arch.nodes.find((n) => n.id === edge.to), from = arch.nodes.find((n) => n.id === edge.from);
  assert.ok(to.sources.some((s) => s.path === 'server/resolvers.js'));
  assert.ok(from.sources.some((s) => /^web\//.test(s.path)));
  const paths = edge.sources.map((s) => s.path);
  assert.ok(paths.some((p) => /^web\//.test(p)) && paths.includes('schema.graphql') && paths.includes('server/resolvers.js'), 'evidence on the client, schema and resolver sides: ' + paths);
  assert.match(edge.summary, /GraphQL operation/);
  const flow = arch.flows.find((f) => /^request-/.test(f.id));
  assert.ok(flow && /GraphQL operation/.test(flow.description));
  assert.deepEqual(validate(arch, root).errors, []);
});

test('tour: without a resolver map nothing is linked, and a repository with no GraphQL is unchanged', () => {
  const root = repo({ ...FILES, 'server/resolvers.js': 'export const resolvers = {};\n' });
  assert.ok(!generate(scanRepo(root)).edges.some((e) => e.kind === 'http'));
  const plain = repo({ 'package.json': '{"name":"x"}', 'main.js': 'console.log(1);\n' });
  assert.ok(!generate(scanRepo(plain)).nodes.some((n) => /graphql/i.test(n.label)));
});

test('website loader: downloads .graphql / .gql documents, so the browser gets the same links', async () => {
  const fetched = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'api.github.com') {
      if (/\/commits\//.test(u.pathname)) return new Response('e'.repeat(40));
      return new Response(JSON.stringify({ truncated: false, tree: Object.keys(FILES).map((p) => ({ path: p, type: 'blob', size: FILES[p].length })) }));
    }
    const p = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
    fetched.push(p);
    return FILES[p] != null ? new Response(FILES[p]) : new Response('', { status: 404 });
  };
  const r = await analyzeRepo({ owner: 'o', repo: 'r', ref: null }, { fetchImpl });
  assert.ok(fetched.includes('schema.graphql') && fetched.includes('web/api.graphql'));
  assert.ok(r.arch.edges.some((e) => e.kind === 'http' && /user/.test(e.label)));
  assert.deepEqual(r.validation.errors, []);
});
