// Optional, opt-in narration written by a language model with the visitor's OWN API key. Off by default: the site never calls
// a model unless the person pastes a key and confirms what will be sent.
//
// What leaves the browser: for each tour step, its title, the labels, kinds and one-line summaries of the components it
// highlights, the relationships between them, and the current templated narration. Labels and summaries are what the analyser wrote,
// so they can contain file and folder names. Never source code and never file contents. The key stays in memory, is sent only to the provider's API host, and is never put in a URL or logged.
//
// What comes back is untrusted text and is checked before it replaces anything: it may only name components and paths that
// the tour already contains, must be short plain prose (no HTML, links or code fences), and if the whole result fails
// validation the templated narration is kept. A step that fails keeps its template. Steps that pass are marked `ai: true`.
//
// Tested against a fake provider only (no network in the tests); see test/narrate-ai.test.mjs.

import { validateCore } from '../core/validate-core.mjs';

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    host: 'api.anthropic.com',
    url: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-5',
    headers: (key) => ({
      'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
      // required by Anthropic to allow a call made directly from a browser
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: (model, system, user) => ({ model, max_tokens: 400, system, messages: [{ role: 'user', content: user }] }),
    text: (json) => (json && Array.isArray(json.content) ? json.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('') : ''),
  },
};

export const SYSTEM_PROMPT = [
  'You write the spoken narration for one step of an animated architecture tour of a software repository.',
  'You are given facts extracted from the code by a static analyser. Use ONLY those facts.',
  'Rules: 1-3 short sentences of plain prose. Name only the components listed. Never invent files, functions, behaviour, versions or numbers.',
  'Do not use markdown, code fences, backticks, links, HTML or bullet points. Do not mention file paths. Reply with the narration text only.',
].join(' ');

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** The facts for one step: exactly what would be sent to the provider. Exported so the UI can show it before anything is sent. */
export function stepFacts(arch, flow, step) {
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(arch.edges.map((e) => [e.id, e]));
  const ids = new Set(step.nodes || []);
  for (const eid of step.edges || []) { const e = edgeById.get(eid); if (e) { ids.add(e.from); ids.add(e.to); } }
  return {
    project: clip(arch.project && arch.project.name, 80),
    flow: clip(flow.title, 80),
    step: clip(step.title, 120),
    components: [...ids].map((id) => byId.get(id)).filter(Boolean).slice(0, 8).map((n) => ({ name: clip(n.label, 60), kind: clip(n.kind, 20), summary: clip(n.summary, 200) })),
    relationships: (step.edges || []).map((id) => edgeById.get(id)).filter(Boolean).slice(0, 6).map((e) => ({ from: clip(byId.get(e.from) && byId.get(e.from).label, 60), to: clip(byId.get(e.to) && byId.get(e.to).label, 60), kind: clip(e.kind, 20), label: clip(e.label, 60) })),
    currentNarration: clip(step.narration, 400),
  };
}

export const userPrompt = (facts) => `Facts (JSON):\n${JSON.stringify(facts, null, 1)}\n\nWrite the narration for this step.`;

/**
 * Accepts model output only when it is short plain prose that names nothing outside the tour.
 * @returns { ok: true, text } | { ok: false, reason }
 */
export function checkNarration(raw, { allowedNames, maxChars = 480 }) {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > maxChars) return { ok: false, reason: 'too long' };
  if (/[<>]|```|`|\]\(|https?:\/\/|www\.|^\s*[-*#>]/m.test(text)) return { ok: false, reason: 'markup, code or a link' };
  // file-like tokens (something/like.this or name.ext) must be a component the tour already shows
  const known = new Set([...allowedNames].map((n) => String(n).toLowerCase()));
  for (const m of text.matchAll(/[\w@.-]+\/[\w@./-]+|\b[\w-]+\.(?:m?[jt]sx?|py|go|rs|java|kt|rb|php|cs|dart|json|ya?ml|sql|prisma|md|html|css)\b/gi)) {
    const tok = m[0].replace(/[.,;:!?]+$/, '').toLowerCase();
    // "and/or" and "read/write" are prose, not paths: a token with slashes counts only when it ends in an extension or has two slashes
    if (tok.includes('/') && !/\.\w{1,6}$/.test(tok) && (tok.match(/\//g) || []).length < 2) continue;
    if (!known.has(tok) && ![...known].some((k) => k.endsWith(tok) || tok.endsWith(k))) return { ok: false, reason: `mentions "${m[0]}", which is not in the tour` };
  }
  return { ok: true, text };
}

async function callProvider({ provider, key, model, facts, fetchImpl, signal }) {
  const p = PROVIDERS[provider];
  let res;
  try {
    res = await fetchImpl(p.url, { method: 'POST', headers: p.headers(key), body: JSON.stringify(p.body(model, SYSTEM_PROMPT, userPrompt(facts))), signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return { error: 'network' };
  }
  if (res.status === 401 || res.status === 403) return { error: 'auth' };
  if (res.status === 429) return { error: 'rate' };
  if (!res.ok) return { error: `http ${res.status}` };
  let json;
  try { json = await res.json(); } catch { return { error: 'bad response' }; }
  return { text: p.text(json) };
}

/**
 * Rewrites the templated narration of the tour steps with a model. Returns a NEW architecture (the input is not modified).
 * @param opts { provider, key, model, fetchImpl, signal, onProgress, maxSteps = 24, concurrency = 3 }
 * @returns { arch, stats: { asked, rewritten, kept, stoppedBecause } }
 */
export async function narrateWithModel(arch, opts) {
  const { provider = 'anthropic', key, fetchImpl = globalThis.fetch, signal, onProgress = () => {}, maxSteps = 24, concurrency = 3 } = opts;
  if (!PROVIDERS[provider]) throw new Error(`Unknown provider "${provider}"`);
  if (!key || typeof key !== 'string') throw new Error('An API key is required.');
  const model = opts.model || PROVIDERS[provider].defaultModel;
  const out = JSON.parse(JSON.stringify(arch));
  const allowedNames = new Set(out.nodes.flatMap((n) => [n.label, n.id, ...(n.sources || []).map((s) => s.path)]).filter(Boolean));
  out.edges.forEach((e) => { if (e.label) allowedNames.add(e.label); });
  const jobs = [];
  for (const flow of out.flows) for (const step of flow.steps) if (jobs.length < maxSteps && !(flow.origin === 'claude' || step.origin === 'claude' || step.origin === 'manual' || step.locked)) jobs.push({ flow, step });
  const stats = { asked: 0, rewritten: 0, kept: 0, stoppedBecause: null };
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length && !stats.stoppedBecause) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { flow, step } = jobs[next++];
      stats.asked++;
      const facts = stepFacts(out, flow, step);
      const r = await callProvider({ provider, key, model, facts, fetchImpl, signal });
      if (r.error === 'auth' || r.error === 'rate') { stats.stoppedBecause = r.error; stats.kept++; }
      else if (r.error) stats.kept++;
      else {
        const names = new Set([...allowedNames, ...facts.components.map((c) => c.name)]);
        const checked = checkNarration(r.text, { allowedNames: names });
        if (checked.ok) { step.narration = checked.text; step.ai = true; stats.rewritten++; } else stats.kept++;
      }
      onProgress({ done: ++done, total: jobs.length, rewritten: stats.rewritten });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (stats.rewritten) out.project.notes = [...(out.project.notes || []), `${stats.rewritten} tour step${stats.rewritten === 1 ? '' : 's'} narrated by ${model} using the visitor's own API key; the rest use the automatic narration. Steps are checked to mention only components in this tour.`];
  return { arch: out, stats };
}

/**
 * narrateWithModel, then the tour's own validator as a final gate: if rewriting introduced any validation error the original
 * architecture is returned untouched (with stats.reverted set), so a model can never make a tour fail its checks.
 */
export async function narrateChecked(arch, view, opts) {
  const validate = opts.validate || ((a) => validateCore(a, view));
  const before = validate(arch).errors.length;
  const { arch: rewritten, stats } = await narrateWithModel(arch, opts);
  const validation = validate(rewritten);
  if (validation.errors.length > before) return { arch, stats: { ...stats, rewritten: 0, reverted: true }, validation: validate(arch) };
  return { arch: rewritten, stats, validation };
}
