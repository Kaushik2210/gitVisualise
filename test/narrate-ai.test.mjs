// Optional AI narration with the visitor's own key, against a fake provider (no network, no real key).
import test from 'node:test';
import assert from 'node:assert/strict';
import { narrateWithModel, narrateChecked, checkNarration, stepFacts, userPrompt, SYSTEM_PROMPT, PROVIDERS } from '../skills/repo-architecture/scripts/lib/web/narrate-ai.mjs';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { repo } from './helpers.mjs';

const SECRET_CODE = 'const TOP_SECRET_TOKEN_IN_SOURCE = "do-not-send-this";';
const files = {
  'package.json': '{"name":"demo","main":"a.js"}',
  'a.js': `import { b } from './b.js';\n${SECRET_CODE}\nexport const a = b;\n`,
  'b.js': "import { c } from './c.js';\nexport const b = c;\n",
  'c.js': 'export const c = 1;\n',
};
const fixture = () => { const root = repo(files); const arch = generate(scanRepo(root)); return { root, arch }; };

/** A fake Anthropic messages endpoint. `reply(facts, n)` decides what the "model" says. */
function fakeProvider(reply, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    const facts = JSON.parse(body.messages[0].content.split('Facts (JSON):\n')[1].split('\n\nWrite the narration')[0]);
    calls.push({ url, headers: init.headers, body, facts });
    if (status !== 200) return new Response('{}', { status });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: reply(facts, calls.length) }] }), { status: 200 });
  };
  return { impl, calls };
}
const good = (facts) => `${facts.step} shows how ${facts.components.map((c) => c.name).slice(0, 2).join(' and ')} work together.`;

test('ai: what is sent is facts only, to the provider host only, with the key in a header and nowhere else', async () => {
  const { arch } = fixture();
  const p = fakeProvider(good);
  await narrateWithModel(arch, { key: 'sk-ant-SECRETKEY', fetchImpl: p.impl, maxSteps: 3 });
  assert.ok(p.calls.length >= 1 && p.calls.length <= 3);
  for (const c of p.calls) {
    assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(c.headers['x-api-key'], 'sk-ant-SECRETKEY');
    assert.equal(c.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.ok(!c.url.includes('SECRETKEY') && !JSON.stringify(c.body).includes('SECRETKEY'), 'the key is never in the URL or the body');
    assert.equal(c.body.system, SYSTEM_PROMPT);
    const sent = JSON.stringify(c.body);
    assert.ok(!sent.includes('TOP_SECRET_TOKEN_IN_SOURCE') && !sent.includes('do-not-send-this'), 'source code is never sent');
    assert.ok(!/"path"|"lines"|"sources"/.test(JSON.stringify(c.facts)), 'no source references, only what the analyser said');
    assert.deepEqual(Object.keys(c.facts).sort(), ['components', 'currentNarration', 'flow', 'project', 'relationships', 'step']);
  }
});

test('ai: accepted narration replaces the template, is marked, and the tour still validates', async () => {
  const { root, arch } = fixture();
  const p = fakeProvider(good);
  const r = await narrateChecked(arch, { exists: (x) => (fs_exists(root, x)), read: (x) => fs_read(root, x), list: () => [], hasBasename: () => true }, { key: 'k', fetchImpl: p.impl, maxSteps: 4 });
  assert.equal(r.stats.reverted, undefined);
  assert.ok(r.stats.rewritten >= 1);
  const changed = r.arch.flows.flatMap((f) => f.steps).filter((s) => s.ai);
  assert.equal(changed.length, r.stats.rewritten);
  assert.ok(changed.every((s) => /shows how/.test(s.narration)));
  assert.ok(r.arch.project.notes.some((n) => /narrated by claude-sonnet-5 using the visitor's own API key/.test(n)));
  assert.deepEqual(validate(r.arch, root).errors, []);
  assert.deepEqual(arch.flows.flatMap((f) => f.steps).filter((s) => s.ai), [], 'the input architecture is not modified');
});
import fs from 'node:fs';
import path from 'node:path';
const fs_exists = (root, rel) => (fs.existsSync(path.join(root, rel)) ? (fs.statSync(path.join(root, rel)).isDirectory() ? 'dir' : 'file') : null);
const fs_read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };

test('ai: output that is not plain prose about this tour is rejected and the template is kept', async () => {
  const { arch } = fixture();
  const names = ['a.js', 'b.js', 'c.js'];
  const bad = {
    'html': 'Nice <img src=x onerror=alert(1)> tour.',
    'link': 'See [the docs](http://evil.example) for more.',
    'url': 'Read more at https://evil.example/x.',
    'backticks': 'It calls `eval` on input.',
    'invented file': 'It then loads secrets/passwords.txt from disk.',
    'invented file 2': 'It imports server.py next.',
    'empty': '   ',
    'too long': 'word '.repeat(200),
    'bullets': '- first point\n- second point',
  };
  for (const [why, text] of Object.entries(bad)) {
    const c = checkNarration(text, { allowedNames: new Set(names) });
    assert.equal(c.ok, false, why);
  }
  for (const text of ['a.js imports b.js and c.js.', 'The entry point wires two modules together, read/write and and/or included.', '"A short quoted line."']) {
    assert.equal(checkNarration(text, { allowedNames: new Set(names) }).ok, true, text);
  }
  const p = fakeProvider(() => 'It then loads secrets/passwords.txt from disk.');
  const r = await narrateWithModel(arch, { key: 'k', fetchImpl: p.impl, maxSteps: 3 });
  assert.equal(r.stats.rewritten, 0);
  assert.equal(r.stats.kept, p.calls.length);
  assert.deepEqual(r.arch.flows.map((f) => f.steps.map((s) => s.narration)), arch.flows.map((f) => f.steps.map((s) => s.narration)), 'every template survived');
  assert.ok(!(r.arch.project.notes || []).some((n) => /narrated by/.test(n)), 'no claim of AI narration when none was accepted');
});

test('ai: a bad key or a rate limit stops the run early, and other failures only cost that step', async () => {
  const { arch } = fixture();
  const auth = fakeProvider(good, { status: 401 });
  const r1 = await narrateWithModel(arch, { key: 'bad', fetchImpl: auth.impl, maxSteps: 10, concurrency: 1 });
  assert.equal(r1.stats.stoppedBecause, 'auth');
  assert.equal(auth.calls.length, 1, 'no further requests after a rejected key');
  const rate = fakeProvider(good, { status: 429 });
  assert.equal((await narrateWithModel(arch, { key: 'k', fetchImpl: rate.impl, concurrency: 1 })).stats.stoppedBecause, 'rate');
  const flaky = fakeProvider(good, { status: 500 });
  const r3 = await narrateWithModel(arch, { key: 'k', fetchImpl: flaky.impl, maxSteps: 3, concurrency: 1 });
  assert.equal(r3.stats.stoppedBecause, null);
  assert.equal(r3.stats.kept, r3.stats.asked);
  const offline = async () => { throw new TypeError('offline'); };
  assert.equal((await narrateWithModel(arch, { key: 'k', fetchImpl: offline, maxSteps: 2 })).stats.rewritten, 0);
});

test('ai: aborting rejects with AbortError and no key means no request', async () => {
  const { arch } = fixture();
  const ctl = new AbortController();
  let n = 0;
  const slow = async (url, init) => { n++; ctl.abort(); throw new DOMException('Aborted', 'AbortError'); };
  await assert.rejects(() => narrateWithModel(arch, { key: 'k', fetchImpl: slow, signal: ctl.signal, concurrency: 1 }), (e) => e.name === 'AbortError');
  assert.equal(n, 1);
  await assert.rejects(() => narrateWithModel(arch, { key: '', fetchImpl: async () => { throw new Error('should not be called'); } }), /API key is required/);
  await assert.rejects(() => narrateWithModel(arch, { key: 'k', provider: 'nope' }), /Unknown provider/);
});

test('ai: authored steps (claude, manual, locked) are never rewritten, and only a few steps are asked', async () => {
  const { arch } = fixture();
  const copy = JSON.parse(JSON.stringify(arch));
  copy.flows[0].steps[0].origin = 'manual';
  copy.flows[0].steps[1] && (copy.flows[0].steps[1].locked = true);
  const p = fakeProvider(good);
  const r = await narrateWithModel(copy, { key: 'k', fetchImpl: p.impl, maxSteps: 2, concurrency: 1 });
  assert.ok(p.calls.length <= 2);
  assert.equal(r.arch.flows[0].steps[0].narration, copy.flows[0].steps[0].narration);
  assert.ok(!p.calls.some((c) => c.facts.step === copy.flows[0].steps[0].title && c.facts.flow === copy.flows[0].title));
});

test('ai: if rewriting would break validation, the original tour is returned untouched', async () => {
  const { arch } = fixture();
  const p = fakeProvider(good);
  // a stricter validator that objects to any AI-written step: the final gate must throw the rewrite away
  const strict = (a) => ({ errors: a.flows.some((f) => f.steps.some((s) => s.ai)) ? ['an AI step failed validation'] : [] });
  const r = await narrateChecked(arch, null, { key: 'k', fetchImpl: p.impl, maxSteps: 3, validate: strict });
  assert.equal(r.stats.reverted, true);
  assert.equal(r.stats.rewritten, 0);
  assert.deepEqual(r.arch, arch, 'the original architecture, untouched');
  assert.deepEqual(r.validation.errors, []);
});

test('ai: facts describe the step and nothing else, and the prompt states its rules', () => {
  const { arch } = fixture();
  const flow = arch.flows[0], step = flow.steps[1];
  const facts = stepFacts(arch, flow, step);
  assert.equal(facts.project, 'demo');
  assert.ok(facts.components.length >= 1 && facts.components.every((c) => c.name && c.kind));
  const prompt = userPrompt(facts);
  assert.match(prompt, /^Facts \(JSON\):/);
  assert.match(SYSTEM_PROMPT, /Use ONLY those facts/);
  assert.match(SYSTEM_PROMPT, /Never invent/);
  assert.equal(PROVIDERS.anthropic.host, 'api.anthropic.com');
});
