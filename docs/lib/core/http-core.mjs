// Pure helpers for tracing HTTP requests from client code to the server routes that handle them.
// Matching is deliberately strict: methods must agree and every path segment must be equal, with
// only path parameters (":id", "{id}", "<int:id>", "${id}") acting as wildcards. Anything that
// cannot be matched this way is left unlinked rather than guessed.

const PARAM = '*';

/** Splits a URL or route path into comparable segments, or returns null if it is not a path. */
export function pathSegments(raw) {
  let p = String(raw || '').trim();
  p = p.replace(/^https?:\/\/[^/?#]+/i, '');                 // absolute URL: keep only the path
  p = p.replace(/^\$\{[^}]*\}(?=\/)/, '');                    // `${BASE_URL}/users`: the leading variable is a host
  p = p.replace(/[?#].*$/, '');                               // query string / fragment
  if (!p.startsWith('/')) return null;
  const segs = p.split('/').filter(Boolean).map((s) => {
    if (/^:\w+/.test(s) || /^\{[^}]*\}$/.test(s) || /^<[^>]*>$/.test(s) || /\$\{[^}]*\}/.test(s) || s === '*') return PARAM;
    return s;
  });
  return segs;
}

const sameSeg = (a, b) => a === PARAM || b === PARAM || a === b;

/** How well a client path fits a route path: -1 for no match, otherwise the number of literal segments that agree. */
export function matchScore(callSegs, routeSegs) {
  if (!callSegs || !routeSegs || callSegs.length !== routeSegs.length) return -1;
  let literal = 0;
  for (let i = 0; i < callSegs.length; i++) {
    if (!sameSeg(callSegs[i], routeSegs[i])) return -1;
    if (callSegs[i] !== PARAM && routeSegs[i] !== PARAM) literal++;
  }
  return literal;
}

const methodOk = (call, route) => call === 'ANY' || route === 'ANY' || call === route;

/**
 * Links each client call to the best matching server routes.
 * A call that matches routes with a different number of literal segments keeps only the most specific ones.
 * @returns {{call: object, route: object}[]}
 */
export function matchRequests(routes, calls) {
  const rs = routes.map((r) => ({ r, segs: pathSegments(r.path) })).filter((x) => x.segs);
  const out = [];
  for (const call of calls) {
    const cs = pathSegments(call.target);
    if (!cs || !cs.length) continue;
    let best = -1, hits = [];
    for (const { r, segs } of rs) {
      if (!methodOk(call.method, r.method)) continue;
      const s = matchScore(cs, segs);
      if (s < 0) continue;
      if (s > best) { best = s; hits = [r]; } else if (s === best) hits.push(r);
    }
    for (const route of hits) out.push({ call, route });
  }
  return out;
}

const HTTP_CLIENT = /^(axios|ky|got|superagent|ofetch|node-fetch|undici|cross-fetch|isomorphic-fetch|requests|httpx|aiohttp|urllib3?)\b/;
export const usesHttpClient = (imports) => imports.some((i) => HTTP_CLIENT.test(i.spec));

// A quoted string; group `n` is the quote, group `n + 1` the contents (which may not span lines).
const str = (n) => '([\'"`])((?:(?!\\' + n + ')[^\\n])*)\\' + n;
const CLIENT_FNS = 'axios|\\$http|ky|got|superagent|ofetch';

/**
 * Finds outgoing HTTP calls in a source file: fetch(), axios/$http/ky/got helpers and, in files that
 * import an HTTP client, `something.get('/path')` on a client instance.
 * Calls carry no `file`; the caller adds it.
 */
export function extractApiCalls(text, { serverFile, clientFile }, lineAt, limit = 60) {
  const calls = [];
  const push = (index, method, target) => {
    if (calls.length < limit) calls.push({ method, target, line: lineAt(text, index) });
  };
  // fetch(url, { method: 'POST' }) and axios(url, { method: 'POST' }): read the method from the options object.
  const methodAfter = (from) => {
    const m = /\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(text.slice(from, from + 300).split(/\b(?:fetch|axios)\s*\(/)[0]);
    return m ? m[1].toUpperCase() : 'GET';
  };
  let m;
  const bases = baseUrls(text);
  const direct = new RegExp('\\b(' + CLIENT_FNS + '|fetch)(?:\\.(get|post|put|delete|patch))?\\(\\s*' + str(3), 'g');
  while ((m = direct.exec(text))) {
    const url = m[1] === 'fetch' || /^https?:/.test(m[4]) ? m[4] : joinUrl(bases[m[1]], m[4]);
    push(m.index, m[2] ? m[2].toUpperCase() : methodAfter(m.index + m[0].length), url);
  }
  if (clientFile && !serverFile) {
    const inst = new RegExp('\\b(?!(?:' + CLIENT_FNS + ')\\b)([A-Za-z_$][\\w$]*)\\.(get|post|put|delete|patch)\\(\\s*' + str(3), 'g');
    while ((m = inst.exec(text))) {
      const base = bases[m[1]];
      // A configured client accepts a relative path ('users'); without a base only rooted paths and URLs are calls.
      if (base || m[4].startsWith('/') || /^https?:/.test(m[4])) push(m.index, m[2].toUpperCase(), joinUrl(base, m[4]));
    }
  }
  return calls;
}

/**
 * Literal base URLs configured on HTTP clients in this file, by the name calls are made on:
 *   const api = axios.create({ baseURL: '/api' })      ky.extend({ prefixUrl: 'api' })      axios.defaults.baseURL = '/api'
 * A base that is a variable or a template is not static, so the client is left without one (its calls stay as written).
 */
export function baseUrls(text) {
  const bases = {};
  const literal = (s) => (/^[`'"]?[^`'"$\n]+[`'"]?$/.test(s) && !s.includes('${') ? s.replace(/^[`'"]|[`'"]$/g, '') : null);
  let m;
  const create = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:axios|ky|got|ofetch)\s*\.\s*(?:create|extend)\s*\(\s*\{([^}]*)\}/g;
  while ((m = create.exec(text))) {
    const b = /\b(?:baseURL|prefixUrl|baseUrl|prefix_url)\s*:\s*([`'"][^`'"\n]*[`'"])/.exec(m[2]);
    const v = b && literal(b[1]);
    if (v) bases[m[1]] = v;
  }
  const defaults = /\baxios\s*\.\s*defaults\s*\.\s*baseURL\s*=\s*([`'"][^`'"\n]*[`'"])/.exec(text);
  if (defaults && literal(defaults[1])) bases.axios = literal(defaults[1]);
  return bases;
}

/** base + path the way HTTP clients join them; an absolute URL in `path` wins, and a base without a leading slash is a path. */
export function joinUrl(base, path) {
  if (!base || /^https?:\/\//i.test(path)) return path;
  const b = /^https?:\/\//i.test(base) ? base : '/' + base.replace(/^\/+/, '');
  return b.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
