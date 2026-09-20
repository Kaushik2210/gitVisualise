'use strict';
// Pure helpers for the extension (no `vscode` import, so they run under plain Node and are unit-tested in test/vscode-ext.test.mjs).
const path = require('node:path');
const fs = require('node:fs');

/**
 * Resolves a repository-relative path from the webview to an absolute path that is guaranteed to stay inside `root`.
 * The webview is treated as untrusted: it shows text taken from a repository, so a message from it must never be able to
 * make the extension open a file elsewhere on the disk. Returns null for anything that is not a plain relative path.
 */
function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\0')) return null;
  if (path.isAbsolute(rel) || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('\\\\') || rel.startsWith('//')) return null;
  const normalised = rel.replace(/\\/g, '/');
  if (normalised.split('/').some((seg) => seg === '..')) return null;
  const abs = path.resolve(root, normalised);
  const relBack = path.relative(root, abs);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) return null;
  let real;
  try { real = fs.realpathSync(abs); } catch { return null; } // must exist
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return null; }
  const back = path.relative(realRoot, real);
  return back.startsWith('..') || path.isAbsolute(back) ? null : real; // a symlink out of the repository is refused too
}

/** A 1-based [start, end] line range, or null. */
function lineRange(lines) {
  if (!Array.isArray(lines) || lines.length !== 2) return null;
  const [a, b] = lines;
  return Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a && b < 10000000 ? [a, b] : null;
}

/**
 * Turns the built tour page into a page a VS Code webview may load: local viewer.css / viewer.js go through the webview URI
 * scheme, every script gets the CSP nonce, and a strict Content-Security-Policy is added (no network, no remote code).
 * @param html   the contents of index.html
 * @param opts   { cspSource, nonce, asUri: (relativeFile) => string }
 */
function prepareWebviewHtml(html, { cspSource, nonce, asUri }) {
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join('; ');
  let out = html
    .replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
    .replace(/(<script\b[^>]*\bsrc=)(["'])(?!https?:|data:)([^"']+)\2/gi, (_m, pre, q, src) => `${pre}${q}${asUri(src)}${q}`)
    .replace(/(<link\b[^>]*\bhref=)(["'])(?!https?:|data:)([^"']+)\2/gi, (_m, pre, q, href) => `${pre}${q}${asUri(href)}${q}`);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => `${m}\n${meta}`) : `${meta}\n${out}`;
  return out;
}

const randomNonce = () => require('node:crypto').randomBytes(16).toString('hex');

module.exports = { resolveInside, lineRange, prepareWebviewHtml, randomNonce };
