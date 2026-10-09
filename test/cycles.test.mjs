// Circular dependencies: found from the import edges the scanner saw, never inferred, and never throwing on odd input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findCycles } from '../skills/repo-architecture/scripts/lib/core/cycles-core.mjs';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { repo } from './helpers.mjs';

const E = (...pairs) => pairs.map(([from, to], i) => ({ id: `e${i}`, from, to }));

test('cycles: a two-way import is one group with a real two-step loop', () => {
  const edges = E(['a', 'b'], ['b', 'a'], ['c', 'a']);
  const [g, ...rest] = findCycles(['a', 'b', 'c'], edges);
  assert.equal(rest.length, 0);
  assert.deepEqual(g.nodes, ['a', 'b']);
  assert.deepEqual(g.edges.sort(), ['e0', 'e1']);       // c -> a is not part of the loop
  assert.equal(g.path.length, 2);
});

test('cycles: a longer loop reports a closed path through its edges', () => {
  const edges = E(['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd']);
  const [g] = findCycles(['a', 'b', 'c', 'd'], edges);
  assert.deepEqual(g.nodes, ['a', 'b', 'c']);
  const byId = Object.fromEntries(edges.map((e) => [e.id, e]));
  const path = g.path.map((id) => byId[id]);
  assert.equal(path.length, 3);
  path.forEach((e, i) => assert.equal(e.to, path[(i + 1) % path.length].from, 'each edge starts where the previous one ended'));
});

test('cycles: acyclic graphs, self-imports and edges to unknown nodes yield nothing', () => {
  assert.deepEqual(findCycles(['a', 'b', 'c'], E(['a', 'b'], ['b', 'c'], ['a', 'c'])), []);
  assert.deepEqual(findCycles(['a'], E(['a', 'a'])), [], 'a file importing itself is not a loop between components');
  assert.deepEqual(findCycles(['a', 'b'], E(['a', 'x'], ['x', 'a'], ['b', 'a'])), [], 'x is not a known node');
  assert.deepEqual(findCycles([], []), []);
});

test('cycles: separate groups come back largest first', () => {
  const edges = E(['a', 'b'], ['b', 'a'], ['x', 'y'], ['y', 'z'], ['z', 'x']);
  const groups = findCycles(['a', 'b', 'x', 'y', 'z'], edges);
  assert.deepEqual(groups.map((g) => g.nodes), [['x', 'y', 'z'], ['a', 'b']]);
});

test('cycles: a very deep import chain does not overflow the stack', () => {
  const n = 20000, ids = Array.from({ length: n }, (_, i) => `n${i}`);
  const edges = ids.map((id, i) => ({ id: `e${i}`, from: id, to: ids[(i + 1) % n] })); // one huge ring
  const [g] = findCycles(ids, edges);
  assert.equal(g.nodes.length, n);
  assert.equal(g.path.length, n);
});

const looped = () => repo({
  'package.json': '{"name":"demo","main":"src/index.js"}',
  'src/index.js': "import { a } from './a.js';\nconsole.log(a);\n",
  'src/a.js': "import { b } from './b.js';\nexport const a = () => b();\n",
  'src/b.js': "import { a } from './a.js';\nexport const b = () => a();\n",
  'src/util.js': 'export const u = 1;\n',
});

test('cycles: a repository with a loop gets a "Circular dependencies" tour that validates', () => {
  const root = looped();
  const arch = generate(scanRepo(root));
  const flow = arch.flows.find((f) => f.id === 'cycles');
  assert.ok(flow, 'cycles flow present: ' + arch.flows.map((f) => f.id));
  assert.match(flow.steps[0].title, /^1 circular dependency$/);
  assert.match(flow.steps[1].title, /a\.js ⇄ b\.js|b\.js ⇄ a\.js/);
  assert.match(flow.steps[1].narration, /a\.js → b\.js → a\.js|b\.js → a\.js → b\.js/);
  const files = new Set(flow.steps[1].sources.map((s) => s.path));
  assert.ok([...files].every((p) => /^src\/[ab]\.js$/.test(p)), 'evidence points at the importing line of a real file');
  assert.deepEqual(validate(arch, root).errors, []);
});

test('cycles: no loop, no tour', () => {
  const root = repo({
    'package.json': '{"name":"demo","main":"src/index.js"}',
    'src/index.js': "import { a } from './a.js';\nimport { b } from './b.js';\nconsole.log(a, b);\n",
    'src/a.js': "import { b } from './b.js';\nexport const a = () => b();\n",
    'src/b.js': 'export const b = () => 1;\n',
  });
  const arch = generate(scanRepo(root));
  assert.equal(arch.flows.find((f) => f.id === 'cycles'), undefined);
});

// ---- imports that do not run at load time never make a loop ----
const cyclesOf = (files) => { const root = repo(files); const arch = generate(scanRepo(root)); return { arch, root, flow: arch.flows.find((f) => f.id === 'cycles') }; };

test('cycles: a Python import under `if TYPE_CHECKING:` is not a runtime loop', () => {
  const { flow } = cyclesOf({
    'pyproject.toml': '[project]\nname = "demo"\n',
    'pkg/__init__.py': '',
    'pkg/main.py': 'from .models import M\nfrom .adapters import A\nprint(M, A)\n',
    'pkg/models.py': 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from .adapters import A\nclass M:\n    pass\n',
    'pkg/adapters.py': 'from .models import M\nclass A:\n    pass\n',
  });
  assert.equal(flow, undefined, 'models -> adapters is typing-only, so adapters <-> models is not a loop');
});

test('cycles: the same Python loop without TYPE_CHECKING is found', () => {
  const { flow } = cyclesOf({
    'pyproject.toml': '[project]\nname = "demo"\n',
    'pkg/__init__.py': '',
    'pkg/main.py': 'from .models import M\nprint(M)\n',
    'pkg/models.py': 'from .adapters import A\nclass M:\n    pass\n',
    'pkg/adapters.py': 'from .models import M\nclass A:\n    pass\n',
  });
  assert.ok(flow);
  assert.match(flow.steps[1].title, /adapters\.py ⇄ models\.py|models\.py ⇄ adapters\.py/);
});

test('cycles: TypeScript `import type` and lazy `import()` do not count, a plain import does', () => {
  const base = { 'package.json': '{"name":"d","main":"src/index.ts"}', 'src/index.ts': "import { a } from './a';\nconsole.log(a);\n" };
  assert.equal(cyclesOf({ ...base, 'src/a.ts': "import { b } from './b';\nexport const a = b;\n", 'src/b.ts': "import type { a } from './a';\nexport const b = 1;\n" }).flow, undefined, 'import type');
  assert.equal(cyclesOf({ ...base, 'src/a.ts': "import { b } from './b';\nexport const a = b;\n", 'src/b.ts': "export const b = () => import('./a');\n" }).flow, undefined, 'dynamic import');
  assert.ok(cyclesOf({ ...base, 'src/a.ts': "import { b } from './b';\nexport const a = b;\n", 'src/b.ts': "import { a } from './a';\nexport const b = a;\n" }).flow, 'plain import');
});

test('cycles: when two files import each other both ways but one way is also a type import, the evidence is the live line', () => {
  const { flow, arch, root } = cyclesOf({
    'package.json': '{"name":"d","main":"src/index.ts"}',
    'src/index.ts': "import { a } from './a';\nconsole.log(a);\n",
    'src/a.ts': "import type { T } from './b';\nimport { b } from './b';\nexport const a = b;\n",
    'src/b.ts': "import { a } from './a';\nexport const b = a;\nexport type T = number;\n",
  });
  assert.ok(flow);
  const cited = flow.steps[1].sources[0];
  assert.ok(!(cited.path === 'src/a.ts' && cited.lines[0] === 1), 'never cite the type-only import on a.ts line 1');
  assert.deepEqual(validate(arch, root).errors, []);
});

test('cycles: Python TYPE_CHECKING under an alias, with a trailing comment, is type-only', () => {
  const { flow } = cyclesOf({
    'pyproject.toml': '[project]\nname = "demo"\n',
    'pkg/__init__.py': '',
    'pkg/main.py': 'from .a import A\nprint(A)\n',
    'pkg/a.py': 'import typing as t\nfrom .b import B\nclass A:\n    pass\n',
    'pkg/b.py': 'import typing as t\nif t.TYPE_CHECKING:  # pragma: no cover\n    from .a import A\nclass B:\n    pass\n',
  });
  assert.equal(flow, undefined);
});

test('cycles: a Python import inside a function runs on call, so it is not a load-time loop; at module level or in try/except it is', () => {
  const files = (b) => ({
    'pyproject.toml': '[project]\nname = "demo"\n', 'pkg/__init__.py': '',
    'pkg/main.py': 'from .a import A\nprint(A)\n',
    'pkg/a.py': 'from .b import B\nclass A:\n    pass\n',
    'pkg/b.py': b,
  });
  assert.equal(cyclesOf(files('class B:\n    def f(self):\n        from .a import A\n        return A\n')).flow, undefined, 'inside a method');
  assert.equal(cyclesOf(files('async def g():\n    from .a import A\n    return A\n')).flow, undefined, 'inside an async function');
  assert.ok(cyclesOf(files('try:\n    from .a import A\nexcept ImportError:\n    A = None\n')).flow, 'try/except at module level still runs on load');
  assert.ok(cyclesOf(files('class B:\n    from .a import A\n')).flow, 'a class body runs on load');
});

test('python: an import written inside a docstring is text, not a dependency', () => {
  const root = repo({
    'pyproject.toml': '[project]\nname = "demo"\n', 'pkg/__init__.py': '',
    'pkg/main.py': 'from .a import A\nprint(A)\n',
    'pkg/a.py': 'class A:\n    """Use it like this::\n\n        from pkg.b import B\n        import pkg.b\n    """\n    pass\nx = """\nfrom pkg.b import B\n"""\nfrom .b import B\n',
    'pkg/b.py': 'from .a import A\nclass B:\n    pass\n',
  });
  const scan = scanRepo(root);
  const a = scan.files.find((f) => f.path === 'pkg/a.py');
  assert.deepEqual(a.imports.map((i) => i.line), [11], 'only the real import at line 11 counts: ' + JSON.stringify(a.imports));
});

test('cycles: a multi-line def signature does not end the function context', () => {
  const { flow } = cyclesOf({
    'pyproject.toml': '[project]\nname = "demo"\n', 'pkg/__init__.py': '',
    'pkg/main.py': 'from .a import A\nprint(A)\n',
    'pkg/a.py': 'from .b import B\nclass A:\n    pass\n',
    'pkg/b.py': 'class B:\n    def run(\n        self,\n        x: int,\n    ) -> None:\n        if x:\n            return\n\n        from .a import A\n        print(A)\n',
  });
  assert.equal(flow, undefined);
});
