// A small YAML reader for the subset that configuration files actually use (Docker Compose, simple manifests): block mappings
// and sequences, flow lists and maps on one line, quoted and plain scalars, comments, and block scalars (skipped). It is not a
// general YAML parser (no anchors, tags, multi-document streams or multi-line flow collections), and it never throws: anything it
// does not understand becomes an empty value. Its point is to keep the line number of every key and list item, so a service or a
// dependency can be pointed at in the file. Pure, no dependencies.
//
// Objects and arrays carry a non-enumerable `$lines`: for an object, key -> 1-based line; for an array, index -> line.

const lines$ = (o, v) => Object.defineProperty(o, '$lines', { value: v, enumerable: false });

/** Removes a trailing comment that is not inside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== '\\') q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) return s.slice(1, -1);
  return s;
}

/** Splits "a, b: c, [d, e]" at top-level commas. */
function splitTop(s) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function flow(raw, line) {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const arr = splitTop(s.slice(1, -1)).map((x) => flow(x, line));
    return lines$(arr, arr.map(() => line));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj = {};
    const ln = {};
    for (const part of splitTop(s.slice(1, -1))) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const k = scalar(part.slice(0, i));
      obj[k] = flow(part.slice(i + 1), line);
      ln[k] = line;
    }
    return lines$(obj, ln);
  }
  return scalar(s);
}

export function parseYaml(text) {
  const toks = [];
  String(text || '').replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) return;
    const body = stripComment(raw);
    if (!body.trim()) return;
    toks.push({ indent: body.match(/^ */)[0].length, text: body.trim(), line: i + 1 });
  });
  let pos = 0;

  const skipBlockScalar = (indent) => { while (pos < toks.length && toks[pos].indent > indent) pos++; };

  function block(indent) {
    if (pos >= toks.length) return null;
    return toks[pos].text.startsWith('- ') || toks[pos].text === '-' ? seq(toks[pos].indent) : map(toks[pos].indent);
  }

  function value(rest, line, parentIndent, allowSameIndentSeq) {
    if (rest === '') {
      if (pos < toks.length && toks[pos].indent > parentIndent) return block(toks[pos].indent);
      if (allowSameIndentSeq && pos < toks.length && toks[pos].indent === parentIndent && /^-( |$)/.test(toks[pos].text)) return seq(parentIndent);
      return null;
    }
    if (/^[|>][+-]?\d*$/.test(rest)) { skipBlockScalar(parentIndent); return ''; }
    if (rest.startsWith('[') || rest.startsWith('{')) return flow(rest, line);
    return scalar(rest);
  }

  function map(indent) {
    const obj = {};
    const ln = {};
    while (pos < toks.length && toks[pos].indent === indent && !/^-( |$)/.test(toks[pos].text)) {
      const t = toks[pos++];
      const m = /^("[^"]*"|'[^']*'|[^\s:][^:]*?)\s*:(?:\s+(.*)|)$/.exec(t.text);
      if (!m) continue;
      const key = scalar(m[1]);
      ln[key] = t.line;
      obj[key] = value((m[2] || '').trim(), t.line, indent, true);
    }
    // tolerate a stray deeper or shallower line rather than looping forever
    if (pos < toks.length && toks[pos].indent > indent && Object.keys(obj).length === 0) pos++;
    return lines$(obj, ln);
  }

  function seq(indent) {
    const arr = [];
    const ln = [];
    while (pos < toks.length && toks[pos].indent === indent && /^-( |$)/.test(toks[pos].text)) {
      const t = toks[pos++];
      const rest = t.text.replace(/^-\s*/, '');
      ln.push(t.line);
      if (rest === '') { arr.push(pos < toks.length && toks[pos].indent > indent ? block(toks[pos].indent) : null); continue; }
      const kv = /^("[^"]*"|'[^']*'|[^\s:{[][^:]*?)\s*:(?:\s+(.*)|)$/.exec(rest);
      if (kv && !rest.startsWith('[') && !rest.startsWith('{')) {
        // "- name: x" opens a mapping whose further keys are indented past the dash
        const item = {};
        const iln = {};
        const key = scalar(kv[1]);
        iln[key] = t.line;
        const childIndent = indent + (t.text.length - rest.length);
        item[key] = value((kv[2] || '').trim(), t.line, childIndent, false);
        while (pos < toks.length && toks[pos].indent === childIndent && !/^-( |$)/.test(toks[pos].text)) {
          const u = toks[pos++];
          const mm = /^("[^"]*"|'[^']*'|[^\s:][^:]*?)\s*:(?:\s+(.*)|)$/.exec(u.text);
          if (!mm) continue;
          const k2 = scalar(mm[1]);
          iln[k2] = u.line;
          item[k2] = value((mm[2] || '').trim(), u.line, childIndent, false);
        }
        arr.push(lines$(item, iln));
      } else arr.push(rest.startsWith('[') || rest.startsWith('{') ? flow(rest, t.line) : scalar(rest));
    }
    return lines$(arr, ln);
  }

  return toks.length ? block(toks[0].indent) : null;
}
