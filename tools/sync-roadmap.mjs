// Rewrites the "Help wanted" list in README.md and the milestone tables in ROADMAP.md from the live GitHub issue state,
// so they cannot go stale. Needs the GitHub CLI (`gh`), logged in. Run: node tools/sync-roadmap.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Kaushik2210/gitVisualise';
const URL_BASE = `https://github.com/${REPO}`;
const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const issues = gh('issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '500', '--json', 'number,title,state,labels,milestone');
const open = issues.filter((i) => i.state === 'OPEN').sort((a, b) => a.number - b.number);
const closed = issues.filter((i) => i.state === 'CLOSED').sort((a, b) => a.number - b.number);
const has = (i, l) => i.labels.some((x) => x.name === l);
const bullet = (i) => `- [#${i.number}](${URL_BASE}/issues/${i.number}) ${i.title}`;
const size = (i) => (has(i, 'good first issue') ? '🟢 good first issue' : has(i, 'ambitious') ? '🔴 ambitious' : '🟡 intermediate');

// ---- README: replace everything from the first tier heading up to "The full plan" ----
let readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const a = readme.indexOf('**🟢 Good first issues**'), b = readme.indexOf('The full plan, grouped into milestones');
if (a < 0 || b < 0) throw new Error('README help-wanted markers not found');
const tier = (title, list) => (list.length ? `**${title}**\n\n${list.map(bullet).join('\n')}\n\n` : '');
const gfi = open.filter((i) => has(i, 'good first issue')), amb = open.filter((i) => has(i, 'ambitious')), mid = open.filter((i) => !gfi.includes(i) && !amb.includes(i));
const body = open.length
  ? tier('🟢 Good first issues (an afternoon each)', gfi) + tier('🟡 Intermediate', mid) + tier('🔴 Ambitious (discuss the design first)', amb)
  : '_Every scoped issue is done. Open one to propose the next._\n\n';
readme = readme.slice(0, a) + body + readme.slice(b);
readme = readme.replace(/<summary><b>✅ Already shipped from this list<\/b> \(\d+ issues? closed\)<\/summary>\n\nClosed so far: [^\n]*/,
  `<summary><b>✅ Already shipped from this list</b> (${closed.length} issues closed)</summary>\n\nClosed so far: ${closed.map((i) => '#' + i.number).join(', ')}`);
fs.writeFileSync(path.join(root, 'README.md'), readme);

// ---- ROADMAP: one table per milestone that still has open issues ----
let road = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');
const ms = gh('api', `repos/${REPO}/milestones?state=all&per_page=100`);
const first = road.indexOf('## [v');
const tail = road.indexOf('## Have a different idea?');
if (first < 0 || tail < 0) throw new Error('ROADMAP markers not found');
const sections = [];
for (const m of ms.sort((x, y) => x.number - y.number)) {
  const list = open.filter((i) => i.milestone && i.milestone.number === m.number);
  if (!list.length) continue;
  sections.push(`## [${m.title}](${URL_BASE}/milestone/${m.number})\n\n${m.description || ''}\n\n| Issue | Size |\n|---|---|\n${list.map((i) => `| [#${i.number}](${URL_BASE}/issues/${i.number}) ${i.title} | ${size(i)} |`).join('\n')}\n`);
}
const unmilestoned = open.filter((i) => !i.milestone);
if (unmilestoned.length) sections.push(`## Not yet scheduled\n\n| Issue | Size |\n|---|---|\n${unmilestoned.map((i) => `| [#${i.number}](${URL_BASE}/issues/${i.number}) ${i.title} | ${size(i)} |`).join('\n')}\n`);
road = road.slice(0, first) + (sections.join('\n') || '_Everything planned has shipped. Open an issue to propose the next thing._\n') + '\n' + road.slice(tail);
fs.writeFileSync(path.join(root, 'ROADMAP.md'), road);
console.log(`README and ROADMAP synced: ${open.length} open, ${closed.length} closed.`);
