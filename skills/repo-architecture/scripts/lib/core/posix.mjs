// Tiny POSIX path helpers so the core logic runs in browsers (no node:path). Repo paths always use "/".
export function normalize(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  const s = out.join('/');
  return abs ? '/' + s : s || '.';
}

export function join(...parts) {
  const joined = parts.filter((p) => p !== '' && p != null).join('/');
  return joined ? normalize(joined) : '.';
}

export function dirname(p) {
  const i = p.lastIndexOf('/');
  if (i < 0) return '.';
  return i === 0 ? '/' : p.slice(0, i);
}

export function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}
