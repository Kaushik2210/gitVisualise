// Shared by the large-repository browser tests: a fake GitHub whose tree has thousands of entries, and a static file server for docs/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const SHA = 'd'.repeat(40);
/** A tree shaped like a big monorepo: thousands of files, a few hundred of them analysable source. */
export function bigTree(n) {
  const exts = ['js', 'js', 'js', 'ts', 'tsx', 'json', 'md', 'snap', 'css', 'yml'];
  const dirs = ['src', 'src/internal', '__tests__', 'src/forks/deep', 'fixtures/a/b'];
  const tree = [{ path: '.gitignore', type: 'blob', size: 20, sha: 'a'.repeat(40) }, { path: 'package.json', type: 'blob', size: 60, sha: 'a'.repeat(40) }];
  for (let i = 0; i < n; i++) tree.push({ path: `packages/pkg-${i % 60}/${dirs[i % 5]}/file${i}.${exts[i % 10]}`, mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 400 + (i % 9000), url: 'https://api.github.com/repos/o/r/git/blobs/' + 'a'.repeat(40) });
  return JSON.stringify({ sha: SHA, truncated: false, tree });
}

export const fakeGithub = (treeText) => `(() => {
  const TREE = ${JSON.stringify(treeText)}, SHA = '${SHA}', real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    const ok = (body, headers) => new Response(body, { status: 200, headers });
    if (u.hostname === 'api.github.com') {
      if (/\\/commits\\//.test(u.pathname)) return ok(SHA, { 'x-ratelimit-remaining': '55' });
      if (/\\/git\\/trees\\//.test(u.pathname)) return ok(TREE);
      return new Response('{}', { status: 404 });
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      const p = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
      if (p === '.gitignore') return ok('dist/\\n');
      if (p === 'package.json') return ok('{"name":"big","main":"packages/pkg-0/src/file0.js"}');
      return ok('import { v } from "./file0.js";\\nexport const v' + p.length + ' = v;\\n');
    }
    return real(input, init);
  };
})();`;

export function serve(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(dir, path.normalize(p));
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

