// gitvisualise website: paste a GitHub link (or pick a repo) -> analysed in your browser -> played in the viewer.
// No backend. Repo content is untrusted, so everything below writes with textContent, never innerHTML.
import { analyzeRepo, compareRepos, resolveCommit, parseRepoInput, listRepos, GitHubError } from './lib/web/github-loader.mjs';
import { createCache, cacheKey } from './lib/web/cache.mjs';
import { idbStore } from './lib/web/idb-store.mjs';
import { buildSnippets, renderPage } from './lib/core/build-core.mjs';
import { keyOf, hashOf, parseHash, stateSuffix, badgeMarkdown } from './lib/web/route.mjs';
import { toMermaid, toPlantUml } from './lib/core/export-core.mjs';
import { narrateChecked, stepFacts, PROVIDERS } from './lib/web/narrate-ai.mjs';
import { validateCore } from './lib/core/validate-core.mjs';
import { newState, authorizeUrl, readCallback, cleanUrl, exchangeCode } from './lib/web/oauth.mjs';
import { galleryImage, validateGallery } from './lib/web/gallery.mjs';
import { OAUTH } from './config.js';

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
const diskCache = createCache(idbStore()); // persistent, per commit; a no-op when IndexedDB is unavailable


// (Link parsing lives in lib/web/route.mjs so it can be unit tested.)
let lastState = null; // { flow, step } most recently reported by the tour
let pendingGoto = null; // position to apply once the tour frame has loaded
function postToFrame(msg) {
  const f = $('frame');
  if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*');
}

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
  f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads');
  old.replaceWith(f);
  if (html) {
    void f.offsetHeight; // flush layout so the frame has a size before its document loads
    f.addEventListener('load', () => {
      tellFrame();
      if (pendingGoto) { postToFrame({ gvGoto: pendingGoto }); pendingGoto = null; }
    });
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

// ---------- theme ----------
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
let theme = THEMES.includes(store.get('theme')) ? store.get('theme') : 'auto';
function tellFrame() {
  const f = $('frame');
  if (f && f.contentWindow) f.contentWindow.postMessage({ gvTheme: theme }, '*');
}
function applyTheme(t, { persist = true, sync = true } = {}) {
  theme = t;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  $('theme').textContent = THEME_LABEL[t];
  $('theme').setAttribute('aria-label', `Theme: ${t}. Click to change.`);
  if (persist) store.set('theme', t);
  if (sync) tellFrame();
}
$('theme').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]));
window.addEventListener('message', (ev) => {
  const f = $('frame');
  if (!f || ev.source !== f.contentWindow || !ev.data || typeof ev.data !== 'object') return;
  if (THEMES.includes(ev.data.gvTheme)) applyTheme(ev.data.gvTheme, { sync: false });
  const st = ev.data.gvState;
  if (st && typeof st.flow === 'string' && st.flow.length < 120 && Number.isInteger(st.step) && st.step >= 0 && lastEntry) {
    lastState = st;
    const h = hashOf(lastEntry.target) + stateSuffix(st);
    if (location.hash !== h) history.replaceState(null, '', h); // keeps the link current without adding history entries
  }
});
applyTheme(theme, { persist: false });

// ---------- run ----------
async function run(input, { push = true } = {}) {
  const target = typeof input === 'string' ? parseRepoInput(input) : input;
  if (!target) {
    showView('landing');
    return showError(new GitHubError('bad_input', 'That does not look like a GitHub repository. Try owner/repo or a github.com link.'));
  }
  hideError();
  lastState = null;
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
    let entry = cache.get(key.toLowerCase()); // in-memory, this tab only
    if (!entry) {
      const a = await loadAssets();
      // One cheap request pins the commit. If we already analysed exactly that commit, skip everything else.
      const { sha, rate } = await resolveCommit(target, { token: token || undefined, signal });
      // Results fetched with a token might come from a private repository: only persist them if the user opted in.
      const persist = !token || $('cache-private').checked;
      // A comparison also needs the base commit; both are pinned before anything is downloaded.
      let baseSha = null;
      if (target.base) baseSha = (await resolveCommit({ owner: target.owner, repo: target.repo, ref: target.base }, { token: token || undefined, signal })).sha;
      const ck = cacheKey(target.owner, target.repo, sha, (target.path ? ':' + target.path : '') + (baseSha ? '<' + baseSha : ''));
      const stored = persist ? await diskCache.get(ck) : null;
      let res, snippets;
      if (stored) {
        res = { arch: stored.arch, validation: stored.validation, meta: { ...stored.meta, fromCache: true, cachedAt: stored.ts, rate }, view: null };
        snippets = stored.snippets;
      } else {
        const load = target.base ? compareRepos : analyzeRepo;
        res = await load(target, { token: token || undefined, signal, onProgress, sha, baseSha, rate, worker: true }); // analysis runs in a Web Worker
        snippets = buildSnippets(res.arch, res.view);
        if (persist) diskCache.set(ck, { arch: res.arch, validation: res.validation, meta: res.meta, snippets, ts: Date.now() }).then(refreshCacheUi);
      }
      const html = renderPage({ arch: res.arch, snippets, template: a.template, inline: { css: a.css, js: a.js } });
      entry = { res, html, snippets };
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
  $('r-sha').textContent = m.compare ? `${m.compare.baseSha.slice(0, 7)}…${m.sha.slice(0, 7)}` : m.sha.slice(0, 7);
  const badge = $('r-badge');
  badge.textContent = m.compare ? 'Comparison: ' + m.compare.base + ' → ' + (m.ref || 'default branch') : m.curated ? 'Curated by the repo’s authors' : 'Auto-generated from the code';
  badge.className = 'badge' + (m.curated ? ' curated' : '');

  const notice = $('r-notice');
  const parts = [];
  let bad = false;
  if (m.curated && res.validation.errors.length) {
    bad = true;
    parts.push(`${res.validation.errors.length} reference${res.validation.errors.length > 1 ? 's' : ''} in this authored tour no longer match the code, so parts may be out of date.`);
  }
  if (m.compare) {
    const s = m.compare.summary;
    parts.push(s.empty ? 'No structural differences between these two revisions.' : `${s.nodes.added} component(s) added, ${s.nodes.removed} removed, ${s.nodes.changed} changed; ${s.edges.added} relationship(s) added, ${s.edges.removed} removed.`);
  } else if (!m.curated) {
    for (const n of res.arch.project.notes || []) if (/^Analysed|truncated/.test(n)) parts.push(n);
    parts.push('This is an automatic picture from imports. Repos can publish a richer, narrated tour with the Claude Code skill.');
  }
  if (m.fromCache) {
    const mins = Math.max(0, Math.round((Date.now() - m.cachedAt) / 60000));
    parts.push(`Loaded from this browser's cache (analysed ${mins < 1 ? 'just now' : mins < 90 ? mins + ' min ago' : Math.round(mins / 60) + ' h ago'}); no download was needed.`);
  }
  if (m.rate && m.rate.remaining != null && m.rate.remaining < 10) parts.push(`GitHub requests left this hour: ${m.rate.remaining}.`);
  notice.textContent = parts.join(' ');
  notice.className = 'notice' + (bad ? '' : ' info');
  // Monorepo: offer one tour per package, or a way back to the whole repository from a single folder.
  notice.querySelectorAll('.pkgs').forEach((n) => n.remove());
  const base = `${m.owner}/${m.repo}${m.ref ? '@' + m.ref : ''}`;
  let chips = null;
  if (m.path) {
    chips = el('div', { class: 'pkgs' }, [el('span', { text: `Showing the folder ${m.path}.` }), el('button', { class: 'chip', type: 'button', text: '← Whole repository', onclick: () => run(base) })]);
  } else if (m.workspaces && m.workspaces.length) {
    chips = el('div', { class: 'pkgs' }, [
      el('span', { text: `Monorepo with ${m.workspaces.length} packages. Analyse one:` }),
      ...m.workspaces.slice(0, 14).map((w) => el('button', { class: 'chip', type: 'button', title: w.dir, text: w.name, onclick: () => run(`${base}:${w.dir}`) })),
      m.workspaces.length > 14 ? el('span', { text: `and ${m.workspaces.length - 14} more (use owner/repo:folder)` }) : null,
    ]);
  }
  if (chips) notice.append(chips);
  notice.hidden = !parts.length && !chips;

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
  const p = parseHash(location.hash);
  const t = p && p.target;
  if (t) {
    if (keyOf(t) !== current) { pendingGoto = p.goto; run(t, { push: false }); }
    else if (p.goto && !$('result').hidden) postToFrame({ gvGoto: p.goto }); // same repo, different step
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
  $('repo-meta').textContent = repoList.length ? (q ? `Showing ${shown.length} of ${repoList.length} repositories.` : `${repoList.length} ${repoList.length === 1 ? 'repository' : 'repositories'}.`) : '';
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
  repoList = [];
  $('repo-tools').hidden = true;
  $('repo-meta').textContent = '';
  box.replaceChildren(el('p', { class: 'muted', text: 'Loading repositories…' }));
  try {
    const all = await listRepos({
      user, token: token || undefined,
      onPage: (soFar) => { repoList = soFar; $('repo-tools').hidden = false; $('filter').value = ''; renderRepos(); }, // show results as pages arrive
    });
    repoList = all;
    $('repo-tools').hidden = !repoList.length;
    renderRepos();
    if (all.capped) $('repo-meta').textContent += ` Showing the ${all.length} most recently pushed; use the filter or paste a link for others.`;
    if (all.error) $('repo-meta').textContent += ' The list is partial: ' + (all.error.message || 'a later page failed to load.');
  } catch (e) {
    box.replaceChildren();
    $('repo-meta').textContent = '';
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

// ---------- gallery ----------
// Real tours anyone can add to by pull request: an entry in gallery.json plus a screenshot,
// no HTML edit needed (see CONTRIBUTING.md). Malformed or duplicate entries are caught by
// test/gallery.test.mjs, so a bad pull request fails CI instead of breaking the page.
async function renderGallery() {
  const holder = $('gcards');
  if (!holder) return;
  let entries;
  try {
    entries = await fetch('gallery.json').then((r) => r.json());
  } catch { return; } // the rest of the page works fine without the gallery
  if (validateGallery(entries).length) return; // built and validated together; a bad file never ships
  for (const g of entries) {
    holder.append(el('button', { class: 'gcard', type: 'button', 'data-repo': g.repo }, [
      el('span', { class: 'shot' }, [
        el('img', { class: 'theme-light', src: galleryImage(g.repo, 'light'), width: 960, height: 540, loading: 'lazy', alt: '' }),
        el('img', { class: 'theme-dark', src: galleryImage(g.repo, 'dark'), width: 960, height: 540, loading: 'lazy', alt: '' }),
      ]),
      el('span', { class: 'gmeta' }, [el('b', { text: g.repo }), el('span', { class: 'tag', text: g.lang })]),
      el('span', { class: 'gdesc', text: g.desc }),
      el('span', { class: 'go-link', text: 'Open the tour →' }),
    ]));
  }
}
renderGallery();

// ---------- wiring ----------
$('go').addEventListener('submit', (e) => { e.preventDefault(); run($('repo').value); });
// Delegated so it also covers the gallery cards, rendered later from gallery.json (see renderGallery below).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-repo]');
  if (!b) return;
  $('repo').value = b.dataset.repo; window.scrollTo({ top: 0, behavior: 'smooth' }); run(b.dataset.repo);
});
$('browse').addEventListener('submit', (e) => { e.preventDefault(); const u = $('user').value.trim(); if (u) browse(u); else if (token) browse(''); else showError(new GitHubError('bad_input', 'Enter a GitHub username, or add a token to list your own repositories.')); });
$('mine').addEventListener('click', () => browse(''));
$('filter').addEventListener('input', renderRepos);
$('cancel').addEventListener('click', back);
$('back').addEventListener('click', back);
$('bring-link').addEventListener('click', () => { back(); setTimeout(() => $('bring').scrollIntoView({ behavior: 'smooth' }), 50); });
$('compare').addEventListener('click', () => {
  if (!lastEntry) return;
  const t = lastEntry.target;
  const base = (window.prompt('Compare ' + t.owner + '/' + t.repo + (t.ref ? '@' + t.ref : '') + ' with which branch, tag or commit? This one is the newer side.', t.base || 'main') || '').trim();
  if (base) run({ owner: t.owner, repo: t.repo, ref: t.ref || null, base, ...(t.path ? { path: t.path } : {}) });
});
$('share').addEventListener('click', async () => {
  const url = location.origin + location.pathname + hashOf(lastEntry.target) + stateSuffix(lastState);
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
});
$('dl-html').addEventListener('click', () => download(`${lastEntry.res.meta.repo}-architecture.html`, 'text/html', lastEntry.html));
$('dl-json').addEventListener('click', () => download(`${lastEntry.res.meta.repo}-architecture.json`, 'application/json', JSON.stringify(lastEntry.res.arch, null, 2) + '\n'));

// ---------- export menu ----------
const copyText = async (text, done) => {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { download('copy.txt', 'text/plain', text); toast('Clipboard is blocked, so it was saved as a file'); }
};
const menu = $('export-menu');
const closeMenu = () => { menu.open = false; };
$('cp-mermaid').addEventListener('click', () => copyText(toMermaid(lastEntry.res.arch), 'Mermaid copied: paste it into a README or an issue'));
$('cp-plantuml').addEventListener('click', () => copyText(toPlantUml(lastEntry.res.arch), 'PlantUML copied'));
$('cp-badge').addEventListener('click', () => {
  try { copyText(badgeMarkdown(lastEntry.target), 'README badge copied'); } catch { toast('Could not build a badge for this link'); }
});
// ---------- optional AI narration (opt-in, the visitor's own key) ----------
const ai = { dlg: $('ai-dialog'), key: $('ai-key'), model: $('ai-model'), confirm: $('ai-confirm'), start: $('ai-start'), status: $('ai-status'), ctl: null };
if (!ai.dlg || typeof ai.dlg.showModal !== 'function') $('ai-open').hidden = true; // no <dialog>: leave the feature out
const aiViewFor = (arch) => { // a read-only view of what the tour cites, for the validation gate (cached tours carry no download)
  const files = new Set(), dirs = new Set();
  const add = (arr) => (arr || []).forEach((s) => { if (s && typeof s.path === 'string') { const p = s.path.replace(/\/$/, ''); files.add(p); const seg = p.split('/'); for (let i = 1; i < seg.length; i++) dirs.add(seg.slice(0, i).join('/')); } });
  arch.nodes.forEach((n) => add(n.sources)); arch.edges.forEach((e) => add(e.sources)); arch.flows.forEach((f) => f.steps.forEach((s) => add(s.sources)));
  return { exists: (p) => (files.has(p) ? 'file' : dirs.has(p) ? 'dir' : null), read: () => null, list: () => [], hasBasename: (n) => [...files].some((p) => p === n || p.endsWith('/' + n)) };
};
const aiSyncStart = () => { ai.start.disabled = !(ai.confirm.checked && ai.key.value.trim().length > 8 && !ai.ctl); };
$('ai-open').addEventListener('click', () => {
  if (!lastEntry) return;
  closeMenu();
  const arch = lastEntry.res.arch;
  ai.model.value = PROVIDERS.anthropic.defaultModel;
  ai.status.textContent = '';
  const flow = arch.flows[0], step = flow && flow.steps[0];
  $('ai-preview').textContent = step ? JSON.stringify(stepFacts(arch, flow, step), null, 2) : '(this tour has no steps)';
  aiSyncStart();
  ai.dlg.showModal();
  ai.key.focus();
});
[ai.key, ai.confirm].forEach((e) => e.addEventListener('input', aiSyncStart));
$('ai-cancel').addEventListener('click', () => { if (ai.ctl) ai.ctl.abort(); ai.key.value = ''; ai.dlg.close(); });
ai.dlg.addEventListener('close', () => { if (ai.ctl) ai.ctl.abort(); ai.key.value = ''; ai.confirm.checked = false; });
ai.start.addEventListener('click', async () => {
  const entry = lastEntry;
  if (!entry || ai.ctl) return;
  ai.ctl = new AbortController();
  ai.start.disabled = true;
  ai.status.textContent = 'Asking the model, step by step\u2026';
  try {
    const arch = entry.res.arch;
    const view = entry.res.view || aiViewFor(arch);
    const r = await narrateChecked(arch, view, {
      key: ai.key.value.trim(), model: ai.model.value.trim() || undefined, signal: ai.ctl.signal,
      onProgress: (p) => { ai.status.textContent = `Narrated ${p.rewritten} of ${p.total} steps\u2026 (${p.done} answered)`; },
      validate: (a) => validateCore(a, view),
    });
    if (r.stats.stoppedBecause === 'auth') ai.status.textContent = 'The provider rejected that API key. Nothing was changed.';
    else if (r.stats.stoppedBecause === 'rate') ai.status.textContent = 'The provider is rate-limiting this key. Try again in a minute.';
    else if (r.stats.reverted) ai.status.textContent = 'The rewritten narration failed the tour\'s own checks, so the original was kept.';
    else if (!r.stats.rewritten) ai.status.textContent = `No step was rewritten (${r.stats.kept} kept the automatic narration).`;
    else {
      const a = await loadAssets();
      entry.res.arch = r.arch;
      entry.html = renderPage({ arch: r.arch, snippets: entry.snippets || {}, template: a.template, inline: { css: a.css, js: a.js } });
      mountFrame(entry.html);
      ai.key.value = '';
      ai.dlg.close();
      toast(`${r.stats.rewritten} step${r.stats.rewritten === 1 ? '' : 's'} narrated by AI (${r.stats.kept} kept the automatic text)`);
    }
  } catch (e) {
    ai.status.textContent = e && e.name === 'AbortError' ? 'Cancelled.' : 'Something went wrong: ' + (e && e.message ? e.message : e);
  } finally {
    ai.ctl = null;
    aiSyncStart();
  }
});
menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', closeMenu));
document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { closeMenu(); menu.querySelector('summary').focus(); } });
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

// ---------- Sign in with GitHub (only when site/config.js sets OAUTH) ----------
// The code-for-token exchange needs a client secret, so it goes through the tiny stateless function in server/github-oauth.
const session = {
  get(k) { try { return sessionStorage.getItem('gv:' + k); } catch { return null; } },
  set(k, v) { try { if (v == null) sessionStorage.removeItem('gv:' + k); else sessionStorage.setItem('gv:' + k, v); } catch { /* storage unavailable */ } },
};
const redirectUri = () => location.origin + location.pathname;
async function handleSignInCallback() {
  if (!OAUTH) return;
  const saved = JSON.parse(session.get('oauth') || 'null');
  const cb = readCallback(location.search, saved && saved.state);
  if (!cb) return;
  session.set('oauth', null);
  history.replaceState(null, '', cleanUrl(location.href) + ((saved && saved.hash) || ''));
  if (cb.error) return showError(new GitHubError('auth', cb.error));
  try {
    tokenInput.value = await exchangeCode({ exchangeUrl: OAUTH.exchangeUrl, code: cb.code, redirectUri: redirectUri() });
    syncToken();
    toast('Signed in with GitHub');
  } catch (e) {
    showError(new GitHubError('auth', e.message));
  }
}
if (OAUTH) {
  $('signin-row').hidden = false;
  $('signin').addEventListener('click', () => {
    const state = newState();
    session.set('oauth', JSON.stringify({ state, hash: location.hash }));
    location.assign(authorizeUrl({ clientId: OAUTH.clientId, redirectUri: redirectUri(), state, scope: OAUTH.scope }));
  });
}

// ---------- cache controls ----------
async function refreshCacheUi() {
  const n = await diskCache.count();
  const b = $('cache-clear');
  b.hidden = !n;
  b.textContent = `Clear cached tours (${n})`;
}
$('cache-clear').addEventListener('click', async () => { await diskCache.clear(); cache.clear(); await refreshCacheUi(); toast('Cache cleared'); });
$('cache-private').checked = store.get('cache-private') === '1';
$('cache-private').addEventListener('change', (e) => store.set('cache-private', e.target.checked ? '1' : null));
refreshCacheUi();

window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);
renderRecent();
await handleSignInCallback();
route();
