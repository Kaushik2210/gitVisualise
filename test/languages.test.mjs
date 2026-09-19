// Scanner tests for language-specific import resolution. Each test builds a throwaway repository in a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';

/** Creates a temp repo from { "path": "contents" } and returns its root. */
export function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gvlang-'));
  for (const [rel, txt] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), txt);
  }
  return root;
}
/** The resolved import targets of a file, as "spec -> resolved|null". */
export const imports = (scan, file) => Object.fromEntries(scan.files.find((f) => f.path === file).imports.map((i) => [i.spec, i.resolved]));
export const externals = (scan) => scan.externals.map((e) => e.name).sort();

test('python: src layout, absolute imports, relative imports and declared third-party packages', () => {
  const root = repo({
    'pyproject.toml': '[project]\nname = "app"\ndependencies = ["requests>=2", "PyYAML"]\n',
    'src/app/__init__.py': 'from .core import run\nfrom app.util import helper\n',
    'src/app/core.py': 'import os\nimport requests\nfrom app.util import helper\nfrom . import config\nfrom .missing import nothing\n',
    'src/app/util.py': 'def helper(): pass\n',
    'src/app/config.py': 'DEBUG = False\n',
  });
  const scan = scanRepo(root);
  assert.deepEqual(imports(scan, 'src/app/__init__.py'), { '.core': 'src/app/core.py', 'app.util': 'src/app/util.py' });
  const core = imports(scan, 'src/app/core.py');
  assert.equal(core['app.util'], 'src/app/util.py');
  assert.equal(core['.'], 'src/app/config.py', '"from . import config" resolves to the sibling module');
  assert.equal(core['.missing'], null, 'an import of a module that does not exist is dropped, not guessed');
  assert.equal(core.os, null, 'standard library modules are not part of the repository');
  assert.equal(core.requests, null);
  assert.deepEqual(externals(scan), ['requests'], 'only declared third-party packages become external nodes (stdlib and unknown names do not)');
});

test('python: parent-relative imports and sibling modules inside packages', () => {
  const root = repo({
    'pkg/__init__.py': '',
    'pkg/core.py': 'VALUE = 1\n',
    'pkg/a/__init__.py': '',
    'pkg/a/b.py': 'from ..core import VALUE\nfrom .sibling import y\nfrom ... import toohigh\n',
    'pkg/a/sibling.py': 'y = 2\n',
  });
  const b = imports(scanRepo(root), 'pkg/a/b.py');
  assert.equal(b['..core'], 'pkg/core.py');
  assert.equal(b['.sibling'], 'pkg/a/sibling.py');
  assert.equal(b['...'], null, 'a relative import that climbs above the repository is dropped');
});

test('python: re-exports through __init__.py and namespace packages', () => {
  const root = repo({
    'lib/__init__.py': 'from .thing import Thing\n',
    'lib/thing.py': 'class Thing: pass\n',
    'main.py': 'from lib import Thing\nfrom nspkg.sub import x\nimport lib.thing\n',
    'nspkg/sub.py': 'x = 1\n', // namespace package: no __init__.py
  });
  const m = imports(scanRepo(root), 'main.py');
  assert.equal(m.lib, 'lib/__init__.py', 'importing a re-exported name lands on the package __init__');
  assert.equal(m['nspkg.sub'], 'nspkg/sub.py', 'namespace packages resolve by file layout');
  assert.equal(m['lib.thing'], 'lib/thing.py');
});

test('python: Python 3 semantics, so a bare import inside a package never resolves to a sibling', () => {
  const root = repo({
    'pkg/__init__.py': '',
    'pkg/a.py': 'import b\nimport json\n', // Python 3: "import b" means a top-level module b, not pkg/b.py
    'pkg/b.py': '',
    'pkg/json.py': '', // must not shadow the standard library import above
    'scripts/run.py': 'import helpers\n', // a script may import siblings: its directory is on sys.path
    'scripts/helpers.py': '',
  });
  const scan = scanRepo(root);
  const a = imports(scan, 'pkg/a.py');
  assert.equal(a.b, null, 'implicit relative imports are not Python 3');
  assert.equal(a.json, null);
  assert.equal(imports(scan, 'scripts/run.py').helpers, 'scripts/helpers.py', 'top-level scripts can import their sibling modules');
});

test('python: the generated architecture validates and never contains a guessed edge', () => {
  const root = repo({
    'requirements.txt': 'flask==3.0\nnumpy\n',
    'app/__init__.py': 'from .views import index\n',
    'app/views.py': 'from flask import Flask\nimport numpy\nfrom .models import User\nimport not_installed\n',
    'app/models.py': 'class User: pass\n',
  });
  const arch = generate(scanRepo(root));
  assert.deepEqual(validate(arch, root).errors, []);
  const ends = arch.edges.map((e) => `${e.from}>${e.to}`);
  assert.ok(ends.some((e) => /views.*>.*models/.test(e)));
  assert.ok(!arch.nodes.some((n) => /not.installed/i.test(n.label)), 'undeclared packages are not invented');
  assert.ok(arch.nodes.some((n) => n.external && n.label === 'flask'));
});

test('js aliases: tsconfig paths and baseUrl, with comments, trailing commas and an extends chain', () => {
  const root = repo({
    'tsconfig.base.json': '{\n  // shared settings\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "@app/*": ["src/app/*"],\n      "@utils": ["src/utils/index.ts"], /* trailing comma below */\n    },\n  },\n}\n',
    'tsconfig.json': '{ "extends": "./tsconfig.base.json" }\n',
    'package.json': '{ "name": "x", "dependencies": { "lodash": "^4" } }',
    'src/main.ts': "import { a } from '@app/a';\nimport u from '@utils';\nimport c from 'components/c';\nimport _ from 'lodash';\nimport nope from '@nope/thing';\n",
    'src/app/a.ts': 'export const a = 1;\n',
    'src/utils/index.ts': 'export default 1;\n',
    'components/c.ts': 'export default 2;\n',
  });
  const scan = scanRepo(root);
  const m = imports(scan, 'src/main.ts');
  assert.equal(m['@app/a'], 'src/app/a.ts', 'wildcard path through an extended config');
  assert.equal(m['@utils'], 'src/utils/index.ts', 'exact path mapping');
  assert.equal(m['components/c'], 'components/c.ts', 'baseUrl-relative import');
  assert.equal(m['@nope/thing'], null, 'an alias that maps to nothing is dropped, not guessed');
  assert.equal(m.lodash, null);
  assert.deepEqual(externals(scan), ['lodash']);
});

test('js aliases: the nearest config wins (monorepo packages can reuse the same alias differently)', () => {
  const root = repo({
    'packages/web/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
    'packages/web/src/index.ts': "import { x } from '@/lib/x';\n",
    'packages/web/src/lib/x.ts': 'export const x = 1;\n',
    'packages/admin/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["app/*"] } } }',
    'packages/admin/app/main.ts': "import { x } from '@/lib/x';\n",
    'packages/admin/app/lib/x.ts': 'export const x = 2;\n',
  });
  const scan = scanRepo(root);
  assert.equal(imports(scan, 'packages/web/src/index.ts')['@/lib/x'], 'packages/web/src/lib/x.ts');
  assert.equal(imports(scan, 'packages/admin/app/main.ts')['@/lib/x'], 'packages/admin/app/lib/x.ts');
});

test('js aliases: simple Vite and webpack alias objects', () => {
  const root = repo({
    'vite.config.js': "import path from 'node:path';\nexport default { resolve: { alias: { '@': path.resolve(__dirname, 'src'), utils: '/src/utils' } } };\n",
    'src/main.js': "import a from '@/a';\nimport h from 'utils/helper';\nimport z from '@/zzz';\n",
    'src/a.js': 'export default 1;\n',
    'src/utils/helper.js': 'export default 2;\n',
  });
  const m = imports(scanRepo(root), 'src/main.js');
  assert.equal(m['@/a'], 'src/a.js');
  assert.equal(m['utils/helper'], 'src/utils/helper.js');
  assert.equal(m['@/zzz'], null);
});

test('parseJsonc: comments, trailing commas, strings that look like comments', async () => {
  const { parseJsonc } = await import('../skills/repo-architecture/scripts/lib/core/scan-core.mjs');
  assert.deepEqual(parseJsonc('{ // c\n "a": "http://x.y/*z*/", /* b */ "b": [1, 2,], }'), { a: 'http://x.y/*z*/', b: [1, 2] });
  assert.equal(parseJsonc('{ nope'), null);
  assert.equal(parseJsonc(''), null);
});
