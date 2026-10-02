// Request tracing for GraphQL. REST has routes; GraphQL has a schema, named operations that clients send, and resolvers that servers
// write. A link is drawn from a client operation to the file that implements the field it asks for, and it is drawn only when every
// step can be read exactly from the code:
//
//   client: `query Users { users { id } }`  (a .graphql / .gql document, or a gql`...` template)   -> the root field `users` (a line)
//   schema: `type Query { users: [User!]! }` (the same kinds of documents)                          -> exactly one definition of Query.users (a line)
//   server: `const resolvers = { Query: { users() {} } }` (a literal resolver map)                  -> exactly one key Query.users (a line)
//
// Anything else stays unlinked: a field with no schema definition, two definitions of the same field, a resolver map built with
// spreads or computed keys (only literal keys are read), two files implementing the same field, a root selection written as a
// fragment spread. Root types are Query and Mutation (renamed through `schema { query: ... }` when the schema says so).
// Pure, no Node APIs, never throws on malformed input.

export const GRAPHQL_FILE_RE = /\.(graphql|gql)$/i;
const MAX_DOC = 400 * 1024;
const MAX_LINKS = 60;

const blank = (s) => s.replace(/[^\n]/g, ' ');
const lineOf = (text, idx) => { let n = 1; for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++; return n; };
const isWord = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isStart = (c) => c !== undefined && /[A-Za-z_]/.test(c);

/** GraphQL source with comments and strings (including """ descriptions) blanked out, positions and newlines kept. */
function maskGql(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('"""', i)) { const e = text.indexOf('"""', i + 3); const end = e < 0 ? text.length : e + 3; out += blank(text.slice(i, end)); i = end; continue; }
    const c = text[i];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1; out += blank(text.slice(i, j + 1)); i = j + 1; continue; }
    if (c === '#') { const e = text.indexOf('\n', i); const end = e < 0 ? text.length : e; out += blank(text.slice(i, end)); i = end; continue; }
    out += c;
    i++;
  }
  return out;
}

/** Balanced `{ ... }` blocks at depth 0, with the header text that precedes each. Braces inside parentheses (default values) are ignored. */
function topBlocks(masked) {
  const blocks = [];
  let depth = 0, paren = 0, open = -1, headStart = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (paren === 0 && c === '{') { if (depth === 0) open = i; depth++; }
    else if (paren === 0 && c === '}' && depth > 0) {
      depth--;
      if (depth === 0) { blocks.push({ header: masked.slice(headStart, open), start: open + 1, end: i }); headStart = i + 1; }
    }
  }
  return blocks;
}

const DEF_RE = /\b(extend\s+type|type|interface|input|enum|query|mutation|subscription|fragment|extend\s+schema|schema)\b/g;
const stripParens = (s) => s.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, ' ');

/** The field names a type body declares: `name(args): Type`. Returns [{ name, offset }]. */
function typeFields(masked, start, end) {
  const out = [];
  let paren = 0, brace = 0, i = start;
  while (i < end) {
    const c = masked[i];
    if (c === '(' || c === '[') paren++;
    else if (c === ')' || c === ']') paren--;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (paren === 0 && brace === 0 && isStart(c) && !isWord(masked[i - 1]) && masked[i - 1] !== '@') {
      let j = i;
      while (j < end && isWord(masked[j])) j++;
      const name = masked.slice(i, j);
      let k = j;
      while (/\s/.test(masked[k] || '')) k++;
      if (masked[k] === '(') { // arguments
        let d = 0;
        for (; k < end; k++) { if (masked[k] === '(') d++; else if (masked[k] === ')' && --d === 0) { k++; break; } }
        while (/\s/.test(masked[k] || '')) k++;
      }
      if (masked[k] === ':') out.push({ name, offset: i });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** The root selections of an operation body: field names written at the top level (aliases resolved to the field, fragments skipped). */
function rootSelections(masked, start, end) {
  const out = [];
  let paren = 0, brace = 0, i = start, skipNext = false;
  while (i < end) {
    const c = masked[i];
    if (c === '(' || c === '[') paren++;
    else if (c === ')' || c === ']') paren--;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (paren === 0 && brace === 0 && isStart(c) && !isWord(masked[i - 1]) && masked[i - 1] !== '@' && masked[i - 1] !== '$') {
      let j = i;
      while (j < end && isWord(masked[j])) j++;
      const name = masked.slice(i, j);
      let k = j;
      while (/\s/.test(masked[k] || '')) k++;
      let p = i - 1;
      while (p >= start && /\s/.test(masked[p])) p--;
      const spread = masked.slice(p - 2, p + 1) === '...';
      if (spread) skipNext = name === 'on'; // `... on Type { }`: the type name is not a field
      else if (skipNext) skipNext = false;
      else if (masked[k] === ':') { /* an alias: the next name is the field */ }
      else out.push({ name, offset: i });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Reads one GraphQL document.
 * @returns { fields: [{ type, name, offset }], roots: { query?, mutation? }, operations: [{ kind, name, selections: [{ name, offset }] }] }
 */
export function parseGraphqlDocument(text) {
  const masked = maskGql(text);
  const fields = [], operations = [], roots = {};
  for (const b of topBlocks(masked)) {
    const header = stripParens(b.header);
    const trimmed = header.trim();
    const kws = [...header.matchAll(DEF_RE)];
    if (!trimmed) { operations.push({ kind: 'query', name: null, selections: rootSelections(masked, b.start, b.end) }); continue; }
    if (!kws.length) continue;
    const kw = kws[kws.length - 1];
    const word = kw[1].replace(/\s+/g, ' ');
    const after = header.slice(kw.index + kw[0].length);
    const nameM = /^\s*([_A-Za-z]\w*)/.exec(after);
    if (word === 'type' || word === 'extend type') {
      if (nameM) for (const f of typeFields(masked, b.start, b.end)) fields.push({ type: nameM[1], name: f.name, offset: f.offset });
    } else if (word === 'schema' || word === 'extend schema') {
      for (const m of masked.slice(b.start, b.end).matchAll(/\b(query|mutation)\s*:\s*([_A-Za-z]\w*)/g)) roots[m[1]] = roots[m[1]] === undefined || roots[m[1]] === m[2] ? m[2] : null;
    } else if (word === 'query' || word === 'mutation') {
      operations.push({ kind: word, name: nameM ? nameM[1] : null, selections: rootSelections(masked, b.start, b.end) });
    }
  }
  return { fields, roots, operations };
}

/** GraphQL documents inside source files: gql`...`, graphql`...`, /* GraphQL *\/ `...`. `${...}` placeholders are blanked. */
export function templateDocuments(text) {
  const docs = [];
  const re = /(?:\b(?:gql|graphql|sdl)\s*\(?|\/\*\s*GraphQL\s*\*\/)\s*`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(text)) && docs.length < 40) {
    const inner = m[1].replace(/\$\{[^}]*\}/g, (s) => blank(s));
    const at = m.index + m[0].indexOf('`') + 1;
    docs.push({ text: inner, line0: lineOf(text, at) - 1 });
  }
  return docs;
}

// ---------- resolver maps (JavaScript / TypeScript) ----------
/** Comments and template literals blanked; inside quotes only the structural characters are neutralised, so quoted keys stay readable. */
function maskJs(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i], two = text.slice(i, i + 2);
    if (two === '//') { const e = text.indexOf('\n', i); const end = e < 0 ? text.length : e; out += blank(text.slice(i, end)); i = end; continue; }
    if (two === '/*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? text.length : e + 2; out += blank(text.slice(i, end)); i = end; continue; }
    if (c === '`') { let j = i + 1; while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1; out += blank(text.slice(i, j + 1)); i = j + 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1).replace(/[{}()[\],:;]/g, '_');
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const matchBrace = (s, open) => { let d = 0; for (let i = open; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) return i; } return -1; };
function enclosingBrace(s, at) { let d = 0; for (let i = at - 1; i >= 0; i--) { if (s[i] === '}') d++; else if (s[i] === '{') { if (d === 0) return i; d--; } } return -1; }

/** The literal keys of an object-literal body: `name`, `name() {}`, `async name() {}`, `name: fn`, `'name': fn`. Spreads and computed keys are not read. */
function objectKeys(s, start, end) {
  const out = [];
  let depth = 0, expect = true, i = start;
  while (i < end) {
    const c = s[i];
    if (depth === 0 && expect) {
      if (/\s/.test(c)) { i++; continue; }
      if (s.startsWith('...', i)) { expect = false; i += 3; continue; }
      if (c === '[') { expect = false; continue; }
      let j = i, name = null;
      if (c === '"' || c === "'") { j = s.indexOf(c, i + 1); if (j < 0 || j > end) break; name = s.slice(i + 1, j); j++; }
      else if (isStart(c) || c === '$') { while (j < end && (isWord(s[j]) || s[j] === '$')) j++; name = s.slice(i, j); }
      else if (c === '*') { i++; continue; }
      if (name === null) { expect = false; i++; continue; }
      let k = j;
      while (/\s/.test(s[k] || '')) k++;
      if ((name === 'async' || name === 'get' || name === 'set') && (isStart(s[k]) || s[k] === '"' || s[k] === "'")) { i = k; continue; } // a modifier
      if (/^[_A-Za-z$][\w$]*$/.test(name) && (s[k] === '(' || s[k] === ':' || s[k] === ',' || s[k] === '}' || k >= end)) out.push({ name, offset: i });
      expect = false;
      i = j;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) expect = true;
    i++;
  }
  return out;
}

/**
 * Literal resolver maps in a source file: `{ Query: { users() {} } }` where the outer object is assigned, default-exported, returned or
 * passed as `resolvers:`, and per-type objects such as `export const Query = { users }`.
 * @returns [{ type, name, line }]
 */
export function resolverKeys(text, rootTypes = ['Query', 'Mutation']) {
  const s = maskJs(text);
  const names = rootTypes.filter((t) => /^[_A-Za-z]\w*$/.test(t)).join('|');
  if (!names) return [];
  const bodies = [];
  const nested = new RegExp(`(?<![\\w$.])(${names})\\s*:\\s*\\{`, 'g');
  let m;
  while ((m = nested.exec(s))) {
    const open = m.index + m[0].length - 1;
    const outer = enclosingBrace(s, m.index);
    if (outer < 0 || !/(=|\bdefault|\bresolvers\s*:|\breturn|\bexports)\s*$/.test(s.slice(Math.max(0, outer - 40), outer))) continue;
    bodies.push({ type: m[1], open });
  }
  const direct = new RegExp(`(?:\\b(?:const|let|var)\\s+(${names})\\s*(?::[^=\\n]+)?|\\b(?:module\\.)?exports\\.(${names}))\\s*=\\s*\\{`, 'g');
  while ((m = direct.exec(s))) bodies.push({ type: m[1] || m[2], open: m.index + m[0].length - 1 });
  const out = [];
  for (const b of bodies) {
    const close = matchBrace(s, b.open);
    if (close < 0) continue;
    for (const k of objectKeys(s, b.open + 1, close)) out.push({ type: b.type, name: k.name, line: lineOf(s, k.offset) });
  }
  return out;
}

/**
 * Joins operations, schema fields and resolver keys.
 * @param docs      [{ file, line0, text }] GraphQL documents (a whole .graphql file has line0 0)
 * @param resolvers [{ file, keys: [{ type, name, line }] }]
 * @returns { links: [{ kind, field, operation, client: { file, line }, schema: { file, line }, resolver: { file, line } }] }
 */
export function linkGraphql(docs, resolvers) {
  const parsed = [];
  const rootOf = { query: new Set(['Query']), mutation: new Set(['Mutation']) };
  for (const d of docs) {
    if (!d || typeof d.text !== 'string' || d.text.length > MAX_DOC) continue;
    let p;
    try { p = parseGraphqlDocument(d.text); } catch { continue; }
    parsed.push({ d, p });
    for (const k of ['query', 'mutation']) if (p.roots[k]) rootOf[k].add(p.roots[k]);
  }
  const kindOfType = (t) => (rootOf.query.has(t) && !rootOf.mutation.has(t) ? 'query' : rootOf.mutation.has(t) && !rootOf.query.has(t) ? 'mutation' : null);
  const lineIn = (d, offsetLine) => d.line0 + offsetLine;

  // schema: every definition of every root field
  const schemaDefs = new Map();
  for (const { d, p } of parsed) {
    for (const f of p.fields) {
      const kind = kindOfType(f.type);
      if (!kind) continue;
      const key = `${kind}.${f.name}`;
      schemaDefs.set(key, [...(schemaDefs.get(key) || []), { file: d.file, line: lineIn(d, lineOf(d.text, f.offset)) }]);
    }
  }
  // resolvers: every literal key of every root-type map
  const implDefs = new Map();
  for (const r of resolvers) {
    for (const k of r.keys) {
      const kind = kindOfType(k.type);
      if (!kind) continue;
      const key = `${kind}.${k.name}`;
      implDefs.set(key, [...(implDefs.get(key) || []), { file: r.file, line: k.line }]);
    }
  }
  const links = [];
  const seen = new Set();
  for (const { d, p } of parsed) {
    for (const op of p.operations) {
      for (const sel of op.selections) {
        const key = `${op.kind}.${sel.name}`;
        const schema = schemaDefs.get(key), impl = implDefs.get(key);
        if (!schema || schema.length !== 1 || !impl || impl.length !== 1) continue; // ambiguity or a missing side: no link
        const client = { file: d.file, line: lineIn(d, lineOf(d.text, sel.offset)) };
        const id = `${client.file}:${client.line}:${key}`;
        if (seen.has(id) || links.length >= MAX_LINKS) continue;
        seen.add(id);
        links.push({ kind: op.kind, field: sel.name, operation: op.name, client, schema: schema[0], resolver: impl[0] });
      }
    }
  }
  return { links };
}

/**
 * Everything together, from file contents.
 * @param graphqlFiles [{ file, text }] .graphql / .gql documents
 * @param sources      [{ file, text }] JavaScript / TypeScript files (templates and resolver maps are read from these)
 */
export function extractGraphql(graphqlFiles, sources) {
  const docs = [];
  for (const f of graphqlFiles) docs.push({ file: f.file, line0: 0, text: f.text });
  for (const f of sources) for (const d of templateDocuments(f.text)) docs.push({ file: f.file, ...d });
  const rootTypes = ['Query', 'Mutation', ...rootNamesIn(docs)];
  const resolvers = [];
  for (const f of sources) {
    let keys = [];
    try { keys = resolverKeys(f.text, rootTypes); } catch { keys = []; }
    if (keys.length) resolvers.push({ file: f.file, keys });
  }
  return linkGraphql(docs, resolvers);
}

/** Renamed root types (`schema { query: RootQuery }`) found in the documents read so far, so resolver maps can use them. */
function rootNamesIn(docs) {
  const names = new Set();
  for (const d of docs) {
    if (typeof d.text !== 'string' || d.text.length > MAX_DOC || !/\bschema\b/.test(d.text)) continue;
    try { const p = parseGraphqlDocument(d.text); for (const n of Object.values(p.roots)) if (n) names.add(n); } catch { /* skip */ }
  }
  return [...names];
}
