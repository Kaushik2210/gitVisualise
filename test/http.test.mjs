// Request-flow tracing: client calls are linked to server routes only when method and path really agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRequests, pathSegments, extractApiCalls } from '../skills/repo-architecture/scripts/lib/core/http-core.mjs';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { repo } from './helpers.mjs';

const pair = (routes, calls) => matchRequests(routes, calls).map((m) => `${m.call.method} ${m.call.target} -> ${m.route.method} ${m.route.path}`);

test('http: path parameters in every dialect act as wildcards, everything else must be equal', () => {
  assert.deepEqual(pathSegments('/users/:id'), ['users', '*']);
  assert.deepEqual(pathSegments('/users/{id}'), ['users', '*']);
  assert.deepEqual(pathSegments('/users/<int:id>'), ['users', '*']);
  assert.deepEqual(pathSegments('/users/${user.id}?x=1'), ['users', '*']);
  assert.deepEqual(pathSegments('https://api.example.com/v1/items/'), ['v1', 'items']);
  assert.deepEqual(pathSegments('${BASE_URL}/items'), ['items']);
  assert.equal(pathSegments('data.json'), null);
});

test('http: methods must agree, and a different path or length never matches', () => {
  const routes = [{ method: 'GET', path: '/users/:id' }, { method: 'POST', path: '/users' }, { method: 'ANY', path: '/health' }];
  assert.deepEqual(pair(routes, [{ method: 'GET', target: '/users/${id}' }]), ['GET /users/${id} -> GET /users/:id']);
  assert.deepEqual(pair(routes, [{ method: 'DELETE', target: '/users/1' }]), []);      // wrong method
  assert.deepEqual(pair(routes, [{ method: 'GET', target: '/users/1/posts' }]), []);   // longer path
  assert.deepEqual(pair(routes, [{ method: 'GET', target: '/orders/1' }]), []);        // different literal
  assert.deepEqual(pair(routes, [{ method: 'PUT', target: '/health' }]), ['PUT /health -> ANY /health']);
});

test('http: a literal route beats a parameter route for the same call', () => {
  const routes = [{ method: 'GET', path: '/users/:id' }, { method: 'GET', path: '/users/me' }];
  assert.deepEqual(pair(routes, [{ method: 'GET', target: '/users/me' }]), ['GET /users/me -> GET /users/me']);
});

test('http: extracts fetch/axios calls with their verbs and ignores non-paths', () => {
  const src = [
    "fetch('/a', { method: 'POST', body: x });",
    'fetch(`/u/${id}`);',
    "axios.delete('/x/1');",
    "api.put('/y', body);",
    "fetch('data.json');",
  ].join('\n');
  const lineAt = (t, i) => t.slice(0, i).split('\n').length;
  const got = extractApiCalls(src, { serverFile: false, clientFile: true }, lineAt).map((c) => `${c.method} ${c.target}@${c.line}`);
  assert.deepEqual(got, ['POST /a@1', 'GET /u/${id}@2', 'DELETE /x/1@3', 'GET data.json@5', 'PUT /y@4']);
  // A server file's own `router.get('/x')` is a route, not an outgoing call.
  assert.deepEqual(extractApiCalls("router.get('/x', h)", { serverFile: true, clientFile: true }, lineAt), []);
});

const fullstack = () => repo({
  'package.json': '{"name":"shop","dependencies":{"express":"4","axios":"1"}}',
  'server/index.js': "import express from 'express';\nimport { listItems } from './items.js';\nconst app = express();\napp.get('/api/items', listItems);\napp.post('/api/items/:id/buy', (req, res) => res.end());\napp.listen(3000);\n",
  'server/items.js': "import { db } from './db.js';\nexport const listItems = (req, res) => res.json(db.items);\n",
  'server/db.js': 'export const db = { items: [] };\n',
  'web/api.js': "import axios from 'axios';\nconst http = axios.create();\nexport const items = () => http.get('/api/items');\nexport const buy = (id) => fetch(`/api/items/${id}/buy`, { method: 'POST' });\nexport const other = () => fetch('/api/nope');\n",
  'web/main.js': "import { items } from './api.js';\nitems();\n",
});

test('http: generates evidence-backed http edges and a request-flow tour that validate', () => {
  const root = fullstack();
  const arch = generate(scanRepo(root), { maxNodes: 4 });
  const http = arch.edges.filter((e) => e.kind === 'http');
  assert.equal(http.length, 1, JSON.stringify(arch.edges.map((e) => e.id)));
  assert.equal(http[0].label, '2 API calls');
  const files = http[0].sources.map((s) => s.path);
  assert.ok(files.some((p) => p.startsWith('web/')) && files.some((p) => p.startsWith('server/')), 'evidence on both sides');
  const flow = arch.flows.find((f) => f.id.startsWith('request-'));
  assert.ok(flow, 'request flow present');
  assert.match(flow.steps[0].title, /sends (GET|POST)/);
  assert.ok(flow.steps[1].edges.includes(http[0].id));
  assert.ok(!JSON.stringify(arch).includes('/api/nope'), 'the unmatched call is not invented into the graph');
  const r = validate(arch, root);
  assert.deepEqual(r.errors, []);
});

test('http: no routes or no matching client call means no http edges or flows', () => {
  const root = repo({ 'a.js': "fetch('/x');\n", 'b.js': "import './a.js';\n" });
  const arch = generate(scanRepo(root));
  assert.ok(!arch.edges.some((e) => e.kind === 'http'));
  assert.ok(!arch.flows.some((f) => f.id.startsWith('request-')));
});

test('http: routes registered on a mounted router get the mount prefix, chained verbs included', () => {
  const root = repo({
    'package.json': '{"name":"shop","dependencies":{"express":"4"}}',
    'server.js': "import express from 'express';\nimport productRoutes from './routes/products.js';\nconst orders = require('./routes/orders.js');\nconst app = express();\napp.use('/api/products', productRoutes);\napp.use('/api/orders', orders);\napp.listen(3000);\n",
    'routes/products.js': "import express from 'express';\nconst router = express.Router();\nrouter.route('/').get(list).post(create);\nrouter.get('/:id', one);\nexport default router;\n",
    'routes/orders.js': "const express = require('express');\nconst router = express.Router();\nrouter.post('/', make);\nmodule.exports = router;\n",
    'client/api.js': "export const one = (id) => fetch(`/api/products/${id}`);\nexport const make = () => fetch('/api/orders', { method: 'POST' });\nexport const bad = () => fetch('/products');\n",
  });
  const scan = scanRepo(root);
  assert.deepEqual(scan.routes.map((r) => `${r.method} ${r.path}`).sort(), ['GET /api/products', 'GET /api/products/:id', 'POST /api/orders', 'POST /api/products']);
  const arch = generate(scan, { maxNodes: 3 });
  const labels = arch.edges.filter((e) => e.kind === 'http').flatMap((e) => e.summary);
  assert.ok(arch.edges.some((e) => e.kind === 'http' && /GET \/api\/products\/:id/.test(e.summary)), labels.join('|'));
  assert.ok(arch.edges.some((e) => e.kind === 'http' && /POST \/api\/orders/.test(e.summary)));
  assert.ok(!arch.edges.some((e) => /\/products\b/.test(e.label) && !/api/.test(e.label)));
});

test('http: a router file mounted under two different prefixes is left unprefixed rather than guessed', () => {
  const root = repo({
    'package.json': '{"dependencies":{"express":"4"}}',
    'app.js': "import express from 'express';\nimport r from './r.js';\nconst app = express();\napp.use('/a', r);\napp.use('/b', r);\n",
    'r.js': "import express from 'express';\nconst router = express.Router();\nrouter.get('/x', h);\nexport default router;\n",
  });
  assert.deepEqual(scanRepo(root).routes.map((r) => r.path), ['/x']);
});

test('http: a literal baseURL / prefixUrl / defaults.baseURL is applied to calls on that client, and only literals', async () => {
  const { baseUrls, joinUrl } = await import('../skills/repo-architecture/scripts/lib/core/http-core.mjs');
  const src = [
    "import axios from 'axios';",
    "const api = axios.create({ timeout: 5, baseURL: '/api/v1' });",
    "const abs = axios.create({ baseURL: 'https://svc.example.com/root/' });",
    "const dyn = axios.create({ baseURL: process.env.API });",
    'const tpl = axios.create({ baseURL: `${HOST}/x` });',
    "const k = ky.extend({ prefixUrl: 'kapi' });",
    "axios.defaults.baseURL = '/global';",
  ].join('\n');
  assert.deepEqual(baseUrls(src), { api: '/api/v1', abs: 'https://svc.example.com/root/', k: 'kapi', axios: '/global' });
  assert.equal(joinUrl('/api/v1', '/users'), '/api/v1/users');
  assert.equal(joinUrl('/api/v1/', 'users'), '/api/v1/users');
  assert.equal(joinUrl('kapi', '/x'), '/kapi/x');
  assert.equal(joinUrl('/api', 'https://other.io/y'), 'https://other.io/y', 'an absolute URL ignores the base');
  assert.equal(joinUrl(undefined, '/x'), '/x');
  const lineAt = (t, i) => t.slice(0, i).split('\n').length;
  const calls = extractApiCalls(src + "\napi.get('/users');\napi.post('items');\naxios.get('/ping');\ndyn.get('/free');\nk.get('feed');\n", { serverFile: false, clientFile: true }, lineAt).map((c) => `${c.method} ${c.target}`);
  assert.deepEqual(calls, ['GET /global/ping', 'GET /api/v1/users', 'POST /api/v1/items', 'GET /free', 'GET /kapi/feed']);
});

test('http: calls through a configured client are linked to the routes that handle them', () => {
  const root = repo({
    'package.json': '{"name":"shop","dependencies":{"express":"4","axios":"1"}}',
    'server/index.js': "import express from 'express';\nconst app = express();\napp.get('/api/v1/items/:id', h);\napp.post('/api/v1/items', h);\napp.get('/health', h);\napp.listen(3000);\n",
    'web/http.js': "import axios from 'axios';\nexport const api = axios.create({ baseURL: '/api/v1' });\nexport const getItem = (id) => api.get(`/items/${id}`);\nexport const addItem = (b) => api.post('items', b);\nexport const nope = () => api.get('/nothing');\n",
  });
  const arch = generate(scanRepo(root), { maxNodes: 3 });
  const http = arch.edges.filter((e) => e.kind === 'http');
  assert.equal(http.length, 1);
  assert.match(http[0].summary, /GET \/api\/v1\/items\/:id/);
  assert.match(http[0].summary, /POST \/api\/v1\/items/);
  assert.ok(!/nothing|health/.test(http[0].summary), 'unmatched calls and unused routes stay out');
  assert.deepEqual(validate(arch, root).errors, []);
});
