// The pull request architecture-diff comment: content, safety and the create / update / skip behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffArchitectures } from '../skills/repo-architecture/scripts/lib/core/diff-core.mjs';
import { buildComment, postComment, run, MARKER, NO_CHANGES_BODY } from '../skills/repo-architecture/scripts/pr-comment.mjs';

const src = [{ path: 'x.js' }];
const node = (id, label, extra = {}) => ({ id, label, kind: 'module', summary: `${label} module.`, sources: src, ...extra });
const base = { schemaVersion: 1, project: { name: 'p' }, nodes: [node('a', 'a.js'), node('b', 'b.js')], edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'imports', label: '1 import', sources: src }], flows: [] };
const head = { ...base, nodes: [node('a', 'a.js', { summary: 'a now does more.' }), node('c', 'c.js')], edges: [{ id: 'e2', from: 'a', to: 'c', kind: 'imports', label: '1 import', sources: src }] };
const diff = diffArchitectures(base, head, { baseRef: 'base', headRef: 'head' });

test('comment: a table of what was added, removed and changed, with a link that opens the comparison', () => {
  const md = buildComment(diff, { repo: 'o/r', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /### Architecture changes/);
  assert.match(md, /\| 🟢 Components added \| 1 \| `c\.js` \|/);
  assert.match(md, /\| 🔴 Components removed \| 1 \| `b\.js` \|/);
  assert.match(md, /\| 🟠 Components changed \| 1 \| `a\.js` \|/);
  assert.match(md, /Relationships added \| 1 \| `a\.js → c\.js \(1 import\)` \|/);
  assert.match(md, /\[See the changes as a tour →\]\(https:\/\/kaushik2210\.github\.io\/gitVisualise\/#\/o\/r@aaaaaaaaaaaa\.\.\.bbbbbbbbbbbb\)/);
  assert.match(md, /one removal plus one addition/);
});

test('comment: nothing to say when nothing changed, and long lists are cut off', () => {
  assert.equal(buildComment(diffArchitectures(base, base, {}), {}), null);
  const many = { ...head, nodes: [...head.nodes, ...Array.from({ length: 20 }, (_, i) => node('n' + i, `new${i}.js`))] };
  const md = buildComment(diffArchitectures(base, many, {}), {});
  assert.match(md, /and 13 more/);
  assert.ok(md.length < 4000, 'stays well inside a comment');
});

test('comment: repository text cannot inject markup, links or extra table cells', () => {
  const evil = { ...head, nodes: [...head.nodes, node('x', 'evil`<img src=x onerror=1>|[click](http://bad.example)\nline2.js')] };
  const md = buildComment(diffArchitectures(base, evil, {}), {});
  // no HTML tag or Markdown link survives; whatever is left is plain text inside a single code span, which renders inert
  assert.ok(!/<img|\[click\]|\]\(http:\/\/bad/.test(md), md);
  assert.match(md, /`evil[^`\n]*line2\.js`/, 'the whole label stays inside one code span');
  assert.ok(md.split('\n').every((l) => !l.startsWith('line2')), 'newlines are flattened');
  const row = md.split('\n').find((l) => l.includes('Components added'));
  assert.equal((row.match(/\|/g) || []).length, 4, 'still a three-cell row');
});

/** A tiny fake of the parts of the GitHub REST API this tool uses. */
function fakeApi({ existing = [], pages = null, denyWrites = false } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', path: u.pathname + u.search, auth: init.headers && init.headers.authorization, body: init.body });
    const json = (status, data) => new Response(JSON.stringify(data), { status });
    if ((init.method || 'GET') === 'GET') {
      const page = Number(u.searchParams.get('page') || 1);
      return json(200, pages ? pages[page - 1] || [] : existing);
    }
    if (denyWrites) return json(403, { message: 'Resource not accessible by integration' });
    return json(init.method === 'POST' ? 201 : 200, { id: 1 });
  };
  return { impl, calls };
}
const ctx = { repo: 'o/r', prNumber: 7, token: 'ghs_secret_token' };

test('post: creates the comment when none exists, and never puts the token in the body', async () => {
  const api = fakeApi();
  const r = await postComment({ ...ctx, body: `${MARKER}\nhello`, fetchImpl: api.impl });
  assert.equal(r.action, 'created');
  const post = api.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, '/repos/o/r/issues/7/comments');
  assert.equal(post.auth, 'Bearer ghs_secret_token');
  assert.ok(!String(post.body).includes('ghs_secret_token'));
});

test('post: updates its own earlier comment instead of adding a new one, even on page two', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, body: 'unrelated ' + i }));
  const page2 = [{ id: 4242, body: `${MARKER}\nold` }];
  const api = fakeApi({ pages: [page1, page2] });
  const r = await postComment({ ...ctx, body: `${MARKER}\nnew`, fetchImpl: api.impl });
  assert.equal(r.action, 'updated');
  assert.equal(api.calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.equal(api.calls.find((c) => c.method === 'PATCH').path, '/repos/o/r/issues/comments/4242');
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0);
});

test('post: with nothing to report it posts nothing, but corrects an existing comment', async () => {
  const none = fakeApi();
  assert.equal((await postComment({ ...ctx, body: null, fetchImpl: none.impl })).action, 'none');
  assert.equal(none.calls.filter((c) => c.method !== 'GET').length, 0, 'no write at all');
  const some = fakeApi({ existing: [{ id: 9, body: `${MARKER}\nstale` }] });
  const r = await postComment({ ...ctx, body: null, fetchImpl: some.impl });
  assert.equal(r.action, 'updated');
  assert.equal(JSON.parse(some.calls.find((c) => c.method === 'PATCH').body).body, NO_CHANGES_BODY);
});

test('post: never fails the build: a read-only token (fork) or a missing token is a skip', async () => {
  const fork = fakeApi({ denyWrites: true });
  const r = await postComment({ ...ctx, body: `${MARKER}\nx`, fetchImpl: fork.impl });
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /403.*read-only/);
  const noTok = fakeApi();
  assert.equal((await postComment({ ...ctx, token: '', body: 'x', fetchImpl: noTok.impl })).action, 'skipped');
  assert.equal(noTok.calls.length, 0, 'without a token nothing is even requested');
  const broken = async () => new Response('nope', { status: 500 });
  assert.equal((await postComment({ ...ctx, body: 'x', fetchImpl: broken })).action, 'skipped');
});

test('run: reads the pull request event and the two architectures, and posts one comment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvprc-'));
  fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, 'head.json'), JSON.stringify(head));
  fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify({ pull_request: { number: 12, base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } } }));
  const api = fakeApi();
  const r = await run({
    baseFile: path.join(dir, 'base.json'), headFile: path.join(dir, 'head.json'), fetchImpl: api.impl,
    env: { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'ghs_x', GITHUB_EVENT_PATH: path.join(dir, 'event.json') },
  });
  assert.equal(r.action, 'created');
  assert.deepEqual(r.summary.nodes, { added: 1, removed: 1, changed: 1 });
  assert.equal(api.calls.find((c) => c.method === 'POST').path, '/repos/o/r/issues/12/comments');
  assert.match(JSON.parse(api.calls.find((c) => c.method === 'POST').body).body, /aaaaaaaaaaaa\.\.\.bbbbbbbbbbbb/);
});

test('action.yml: the comment step is opt-in, needs a pull request, and uses the workflow token by default', () => {
  const y = fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(y, /comment-diff:[\s\S]*?default: 'false'/);
  assert.match(y, /github-token:[\s\S]*?default: \$\{\{ github\.token \}\}/);
  assert.match(y, /if: \$\{\{ inputs\.comment-diff == 'true' && github\.event_name == 'pull_request' \}\}/);
  assert.match(y, /pr-comment\.mjs" --base/);
});
