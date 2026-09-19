// Pure text helpers shared by Node and the browser.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

export function countLines(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Normalises a git remote to https://github.com/owner/repo (null when not GitHub). */
export function githubUrl(remote) {
  if (!remote) return null;
  const m =
    remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/) ||
    remote.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}
