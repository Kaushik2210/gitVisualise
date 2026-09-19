// gitvisualise website: paste a GitHub link (or pick a repo) -> analysed in your browser -> played in the viewer.
// No backend. Repo content is untrusted, so everything below writes with textContent, never innerHTML.
import { analyzeRepo, parseRepoInput, listRepos, GitHubError } from './lib/web/github-loader.mjs';
import { buildSnippets, renderPage } from './lib/core/build-core.mjs';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem('gv:' + k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem('gv:' + k); else localStorage.setItem('gv:' + k, v); } catch { /* storage unavailable */ } },
};
const el = (tag, props = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  kids.forEach((c) => c && e.append(c));
  return e;
};

// ---------- state ----------
let token = store.get('token') || '';
let controller = null;
let current = null; // key of the repo being shown/analysed
const cache = new Map(); // key -> { res, html }
let assets = null;
let lastEntry = null;

const keyOf = (t) => `${t.owner}/${t.repo}${t.ref ? '@' + t.ref : ''}`;
const hashOf = (t) => '#/' + keyOf(t);

// ---------- views ----------
/**
 * Always mount a brand-new frame, and only after the result view is visible.
 * Reusing one frame that was created inside a display:none container, and navigating it in the same task that
 * un-hides the container, can leave the sandboxed document without any layout (a blank tour). A fresh frame
 * inserted into an already-visible container always renders.
 */
function mountFrame(html) {
  const old = $('frame');
  const f = document.createElement('iframe');
  f.id = 'frame';
  f.title = 'Architecture tour';
  // Scripts run, but with an opaque origin: nothing in a repository can reach this page or a stored token.
  f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  old.replaceWith(f);
  if (html) {
    void f.offsetHeight; // flush layout so the frame has a size before its document loads
    f.srcdoc = html;
  }
}

function showView(name) {
  $('landing').hidden = name !== 'landing';
  $('progress').hidden = name !== 'progress';
  $('result').hidden = name !== 'result';
  document.body.style.overflow = name === 'result' ? 'hidden' : '';
  if (name !== 'result') mountFrame(''); // stop any running tour (scripts, speech) when leaving the result view
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.id);
  toast.id = setTimeout(() => { t.hidden = true; }, 2200);
}

function showError(e) {
  const box = $('err');
  box.replaceChildren();
  let msg = e instanceof GitHubError ? e.message : `Something went wrong: ${e && e.message ? e.message : e}`;
  const extras = [];
  if (e instanceof GitHubError) {
    if (e.kind === 'rate_limit') {
      const when = e.resetAt ? ` It resets around ${e.resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
      msg += when + ' Add a free GitHub token to continue right away.';
      extras.push(el('button', { class: 'btn small', type: 'button', text: 'Add a token', onclick: openToken }));
    } else if (e.kind === 'not_found' && !e.hasToken) {
      msg += ' If it is private, add a token.';
      extras.push(el('button', { class: 'btn small', type: 'button', text: 'Add a token', onclick: openToken }));
    }
  }
  box.append(document.createTextNode(msg), ...extras);
  box.hidden = false;
}
const hideError = () => { $('err').hidden = true; };

function openToken() {
  const d = $('token-box');
  d.open = true;
  d.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('token').focus();
}

// ---------- viewer assets ----------
function loadAssets() {
  assets ||= Promise.all(['viewer/index.template.html', 'viewer/viewer.css', 'viewer/viewer.js'].map((u) =>
    fetch(u).then((r) => { if (!r.ok) throw new Error(`Could not load ${u}`); return r.text(); }),
  )).then(([template, css, js]) => ({ template, css, js }));
  return assets;
}

// ---------- progress ----------
const STAGES = ['resolve', 'tree', 'download', 'analyse'];
function onProgress(evt) {
  const idx = STAGES.indexOf(evt.stage);
  document.querySelectorAll('#prog-steps li').forEach((li, i) => {
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
  });
  let pct = [8, 20, 24, 94][idx];
  if (evt.stage === 'download' && evt.total) {
    pct = 24 + 66 * (evt.done / evt.total);
    $('prog-count').textContent = `(${evt.done}/${evt.total})`;
  } else $('prog-count').textContent = '';
  $('prog-bar').style.width = `${Math.max(4, Math.min(100, pct))}%`;
}

// ---------- run ----------
async function run(input, { push = true } = {}) {
  const target = typeof input === 'string' ? parseRepoInput(input) : input;
  if (!target) {
    showView('landing');
    return showError(new GitHubError('bad_input', 'That does not look like a GitHub repository. Try owner/repo or a github.com link.'));
  }
  hideError();
  const key = keyOf(target);
  current = key;
  if (push && location.hash !== hashOf(target)) history.pushState(null, '', hashOf(target));

  if (controller) controller.abort();
  controller = new AbortController();
  const { signal } = controller;

  $('prog-title').textContent = `Analysing ${target.owner}/${target.repo}`;
  document.querySelectorAll('#prog-steps li').forEach((li) => li.classList.remove('done', 'active'));
  $('prog-bar').style.width = '4%';
  showView('progress');
  onProgress({ stage: 'resolve' });

  try {
    let entry = cache.get(key.toLowerCase());
    if (!entry) {
      const [res, a] = await Promise.all([analyzeRepo(target, { token: token || undefined, signal, onProgress }), loadAssets()]);
      const html = renderPage({ arch: res.arch, snippets: buildSnippets(res.arch, res.view), template: a.template, inline: { css: a.css, js: a.js } });
      entry = { res, html };
      cache.set(key.toLowerCase(), entry);
    }
    if (signal.aborted || current !== key) return;
    remember(`${target.owner}/${target.repo}`);
    showResult(entry, target);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    current = null;
    if (location.hash === hashOf(target)) history.replaceState(null, '', location.pathname + location.search);
    showView('landing');
    showError(e);
    window.scrollTo({ top: 0 });
  }
}

function showResult(entry, target) {
  lastEntry = { ...entry, target };
  const { res } = entry;
  const m = res.meta;
  const title = $('r-title');
  title.textContent = `${m.owner}/${m.repo}`;
  title.href = m.repoUrl;
  $('r-sha').textContent = m.sha.slice(0, 7);
  const badge = $('r-badge');
  badge.textContent = m.curated ? 'Curated by the repo’s authors' : 'Auto-generated from the code';
  badge.className = 'badge' + (m.curated ? ' curated' : '');

  const notice = $('r-notice');
  const parts = [];
  let bad = false;
  if (m.curated && res.validation.errors.length) {
    bad = true;
    parts.push(`${res.validation.errors.length} reference${res.validation.errors.length > 1 ? 's' : ''} in this authored tour no longer match the code, so parts may be out of date.`);
  }
  if (!m.curated) {
    for (const n of res.arch.project.notes || []) if (/^Analysed|truncated/.test(n)) parts.push(n);
    parts.push('This is an automatic picture from imports. Repos can publish a richer, narrated tour with the Claude Code skill.');
  }
  if (m.rate && m.rate.remaining != null && m.rate.remaining < 10) parts.push(`GitHub requests left this hour: ${m.rate.remaining}.`);
  notice.textContent = parts.join(' ');
  notice.className = 'notice' + (bad ? '' : ' info');
  notice.hidden = !parts.length;

  showView('result');
  mountFrame(entry.html);
}

function back() {
  if (controller) controller.abort();
  current = null;
  if (/^#\//.test(location.hash)) history.pushState(null, '', location.pathname + location.search);
  showView('landing');
  window.scrollTo({ top: 0 });
}

function route() {
  const t = /^#\//.test(location.hash) ? parseRepoInput(location.hash.slice(2)) : null;
  if (t) {
    if (keyOf(t) !== current) run(t, { push: false });
  } else if ($('landing').hidden) {
    if (controller) controller.abort();
    current = null;
    showView('landing');
  }
}

// ---------- recent ----------
function remember(name) {
  const list = [name, ...JSON.parse(store.get('recent') || '[]').filter((x) => x.toLowerCase() !== name.toLowerCase())].slice(0, 6);
  store.set('recent', JSON.stringify(list));
  renderRecent();
}
function renderRecent() {
  let list = [];
  try { list = JSON.parse(store.get('recent') || '[]'); } catch { /* ignore */ }
  const box = $('recent');
  box.replaceChildren();
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  box.append(el('span', { text: 'Recent:' }), ...list.map((n) => el('button', { class: 'chip', type: 'button', text: n, onclick: () => run(n) })));
}

// ---------- repo picker ----------
let repoList = [];
function ago(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (!isFinite(d)) return '';
  if (d < 1) return 'today';
  if (d < 30) return `${Math.floor(d)}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
function renderRepos() {
  const q = $('filter').value.trim().toLowerCase();
  const box = $('repos');
  box.replaceChildren();
  const shown = repoList.filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  if (!shown.length) { box.append(el('p', { class: 'muted', text: repoList.length ? 'No repositories match.' : 'No repositories found.' })); return; }
  for (const r of shown) {
    const name = el('b', { text: r.name }, r.private ? [el('span', { class: 'lock', text: 'private' })] : []);
    box.append(el('button', { class: 'repo', type: 'button', onclick: () => run(r.fullName) }, [
      name,
      el('p', { text: r.description || 'No description' }),
      el('div', { class: 'meta' }, [
        r.language && el('span', { text: r.language }),
        el('span', { text: `★ ${r.stars}` }),
        r.updated && el('span', { text: ago(r.updated) }),
        r.fork && el('span', { text: 'fork' }),
      ]),
    ]));
  }
}
async function browse(user) {
  hideError();
  const box = $('repos');
  box.replaceChildren(el('p', { class: 'muted', text: 'Loading repositories…' }));
  try {
    repoList = await listRepos({ user, token: token || undefined });
    $('repo-tools').hidden = !repoList.length;
    $('filter').value = '';
    renderRepos();
  } catch (e) {
    box.replaceChildren();
    showError(e);
  }
}

// ---------- downloads & sharing ----------
function download(name, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- wiring ----------
$('go').addEventListener('submit', (e) => { e.preventDefault(); run($('repo').value); });
document.querySelectorAll('.examples .chip[data-repo]').forEach((b) => b.addEventListener('click', () => { $('repo').value = b.dataset.repo; run(b.dataset.repo); }));
$('browse').addEventListener('submit', (e) => { e.preventDefault(); const u = $('user').value.trim(); if (u) browse(u); else if (token) browse(''); else showError(new GitHubError('bad_input', 'Enter a GitHub username, or add a token to list your own repositories.')); });
$('mine').addEventListener('click', () => browse(''));
$('filter').addEventListener('input', renderRepos);
$('cancel').addEventListener('click', back);
$('back').addEventListener('click', back);
$('bring-link').addEventListener('click', () => { back(); setTimeout(() => $('bring').scrollIntoView({ behavior: 'smooth' }), 50); });
$('share').addEventListener('click', async () => {
  const url = location.origin + location.pathname + hashOf(lastEntry.target);
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
});
$('dl-html').addEventListener('click', () => download(`${lastEntry.res.meta.repo}-architecture.html`, 'text/html', lastEntry.html));
$('dl-json').addEventListener('click', () => download(`${lastEntry.res.meta.repo}-architecture.json`, 'application/json', JSON.stringify(lastEntry.res.arch, null, 2) + '\n'));
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); toast('Copied'); } catch { toast('Select the text and copy it'); }
}));

const tokenInput = $('token');
function syncToken() {
  token = tokenInput.value.trim();
  $('mine').hidden = !token;
  if ($('remember').checked && token) store.set('token', token); else store.set('token', null);
}
tokenInput.addEventListener('input', syncToken);
$('remember').addEventListener('change', syncToken);
if (token) { tokenInput.value = token; $('remember').checked = true; $('mine').hidden = false; }

window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);
renderRecent();
route();
