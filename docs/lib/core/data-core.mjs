// Data-model view: the tables a SQL schema declares (CREATE TABLE) and the models of a Prisma schema, with the relationships
// between them (foreign keys, @relation). Each entity and each relationship carries the file and line it was read from.
// ORM models in application code (Django, SQLAlchemy, TypeORM) are not read yet.

export const SQL_RE = /\.sql$/i;
export const PRISMA_RE = /(^|\/)schema\.prisma$|\.prisma$/i;
/** Files the website must download for this view, besides source files. */
export const DATA_FILE_RE = /\.sql$|\.prisma$/i;

const lineAt = (text, idx) => { let n = 1; for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++; return n; };
const unquote = (s) => String(s).trim().replace(/^[`"[]|[`"\]]$/g, '');
/** "public"."Users" -> Users; a schema prefix is not part of the name people use. */
const tableName = (s) => unquote(String(s).trim().split('.').pop());
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Replaces comments with spaces (same length) so character offsets, and therefore line numbers, stay valid. */
function blankComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function splitColumns(body) {
  const parts = [];
  let depth = 0, cur = '', start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push({ text: cur, at: start }); cur = ''; start = i + 1; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push({ text: cur, at: start });
  return parts;
}

export function parseSql(file, raw) {
  const text = blankComments(raw);
  const entities = [];
  const re = /\bcreate\s+(?:global\s+|local\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:[`"[]?[\w$]+[`"\]]?\s*\.\s*)*[`"[]?[\w$]+[`"\]]?)\s*\(/gi;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    const close = balanced(text, open);
    if (close < 0) continue;
    const name = tableName(m[1]);
    const body = text.slice(open + 1, close);
    const cols = [];
    const refs = [];
    for (const part of splitColumns(body)) {
      const t = part.text.trim();
      if (!t) continue;
      const partLine = lineAt(text, open + 1 + part.at + (part.text.length - part.text.trimStart().length));
      const fk = /^(?:constraint\s+[`"[]?[\w$]+[`"\]]?\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+((?:[`"[]?[\w$]+[`"\]]?\s*\.\s*)*[`"[]?[\w$]+[`"\]]?)/i.exec(t);
      if (fk) { refs.push({ to: tableName(fk[2]), column: unquote(fk[1].split(',')[0]), line: partLine }); continue; }
      if (/^(?:constraint|primary\s+key|unique|check|index|key|exclude|fulltext|spatial|like)\b/i.test(t)) continue;
      const col = /^([`"[]?[\w$]+[`"\]]?)\s+([A-Za-z][\w]*(?:\s*\([^)]*\))?)/.exec(t);
      if (!col) continue;
      cols.push({ name: unquote(col[1]), type: col[2].replace(/\s+/g, '') });
      const inline = /\breferences\s+((?:[`"[]?[\w$]+[`"\]]?\s*\.\s*)*[`"[]?[\w$]+[`"\]]?)/i.exec(t);
      if (inline) refs.push({ to: tableName(inline[1]), column: unquote(col[1]), line: partLine });
    }
    entities.push({ name, kind: 'table', file, line: lineAt(text, m.index), endLine: lineAt(text, close), columns: cols, refs });
  }
  return entities;
}

export function parsePrisma(file, raw) {
  const text = blankComments(raw.replace(/\/\/[^\n]*/g, (s) => ' '.repeat(s.length)));
  const models = [];
  const re = /^[ \t]*model\s+(\w+)\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0, close = -1;
    for (let i = open; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) { close = i; break; } }
    if (close < 0) continue;
    const startLine = lineAt(text, m.index);
    const body = text.slice(open + 1, close);
    const cols = [], refs = [];
    body.split('\n').forEach((ln, i) => {
      const t = ln.trim();
      if (!t || t.startsWith('@@')) return;
      const f = /^(\w+)\s+([A-Za-z]\w*)(\[\])?(\?)?(.*)$/.exec(t);
      if (!f) return;
      const line = lineAt(text, open + 1) + i;
      cols.push({ name: f[1], type: f[2] + (f[3] || '') + (f[4] || '') });
      // @relation(fields: [...]) marks the side that holds the foreign key
      const rel = /@relation\s*\(([^)]*)\)/.exec(f[5] || '');
      if (rel && /fields\s*:/.test(rel[1])) refs.push({ to: f[2], column: f[1], line });
    });
    models.push({ name: m[1], kind: 'model', file, line: startLine, endLine: lineAt(text, close), columns: cols, refs });
  }
  // a column whose type is another model is a relation, not a stored column
  const names = new Set(models.map((x) => x.name));
  models.forEach((mdl) => { mdl.columns = mdl.columns.filter((c) => !names.has(c.type.replace(/[[\]?]/g, ''))); });
  return models;
}


/** Foreign keys added after the fact: ALTER TABLE t ADD [CONSTRAINT n] FOREIGN KEY (c) REFERENCES other (id). Migrations use this a lot. */
export function parseSqlAlters(file, raw) {
  const text = blankComments(raw);
  const out = [];
  const name = '((?:[`"[]?[\\w$]+[`"\\]]?\\s*\\.\\s*)*[`"[]?[\\w$]+[`"\\]]?)';
  const re = new RegExp(`\\balter\\s+table\\s+(?:only\\s+|if\\s+exists\\s+)*${name}[^;]*?\\bforeign\\s+key\\s*\\(([^)]*)\\)\\s*references\\s+${name}`, 'gi');
  let m;
  while ((m = re.exec(text))) out.push({ table: tableName(m[1]), to: tableName(m[3]), column: unquote(m[2].split(',')[0]), file, line: lineAt(text, m.index) });
  return out;
}

// Where a definition comes from decides which copy of a table wins: the schema people maintain, not the migration history.
const priority = (file, kind) => (kind === 'model' ? 0 : /(^|\/)(migrations?|migrate|db\/migrate|alembic\/versions)\//i.test(file) ? 2 : 1);

/**
 * @returns { entities, relations } where relations are { from, to, column, file, line } between entities that exist.
 * A table that appears in several files (a migration history) is one entity, taken from the most authoritative file.
 */
export function extractDataModel(paths, read) {
  const found = [];
  const alters = [];
  for (const file of paths) {
    if (file.split('/').length > 8 || /(^|\/)(node_modules|vendor|dist|build)\//.test(file)) continue;
    if (SQL_RE.test(file)) {
      const t = read(file);
      if (!t) continue;
      if (/create\s+table/i.test(t)) found.push(...parseSql(file, t));
      if (/alter\s+table/i.test(t)) alters.push(...parseSqlAlters(file, t));
    } else if (PRISMA_RE.test(file)) {
      const t = read(file);
      if (t) found.push(...parsePrisma(file, t));
    }
  }
  const byName = new Map();
  for (const e of found.sort((a, b) => priority(a.file, a.kind) - priority(b.file, b.kind))) {
    const k = e.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, { ...e, refs: [...e.refs] });
  }
  for (const a of alters) {
    const e = byName.get(a.table.toLowerCase());
    if (e && !e.refs.some((r) => same(r.to, a.to) && r.column === a.column)) e.refs.push({ to: a.to, column: a.column, line: a.line, file: a.file });
  }
  const unique = [...byName.values()].slice(0, 60);
  const relations = [];
  for (const e of unique) {
    for (const r of e.refs) {
      const target = byName.get(r.to.toLowerCase());
      if (target && target !== byName.get(e.name.toLowerCase()) && unique.includes(target) && !relations.some((x) => x.from === e && x.to === target)) {
        relations.push({ from: e, to: target, column: r.column, file: r.file || e.file, line: r.line });
      }
    }
  }
  return { entities: unique, relations };
}
