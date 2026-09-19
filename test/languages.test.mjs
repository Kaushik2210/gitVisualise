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

const MAVEN = `<project>
  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>3.14.0</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;

function javaRepo(extra = {}) {
  return repo({
    'pom.xml': MAVEN,
    'src/main/java/com/acme/App.java': [
      'package com.acme;', '',
      'import com.acme.util.Strings;',
      'import com.acme.model.*;',
      'import static com.acme.util.Strings.shout;',
      'import com.acme.util.Strings.Inner;',
      'import org.apache.commons.lang3.StringUtils;',
      'import java.util.List;',
      'import com.other.Missing;',
      '// import com.acme.ghost.Ghost;',
      '',
      '/** Application entry point. */',
      'public class App {',
      '  public static void main(String[] args) {}',
      '}', ''].join('\n'),
    'src/main/java/com/acme/util/Strings.java': 'package com.acme.util;\n\npublic class Strings {\n  public static String shout(String s) { return s; }\n  public static class Inner {}\n}\n',
    'src/main/java/com/acme/model/User.java': 'package com.acme.model;\npublic class User {}\n',
    'src/main/java/com/acme/model/Order.java': 'package com.acme.model;\npublic class Order {}\n',
    'src/test/java/com/acme/AppTest.java': 'package com.acme;\nimport org.junit.Test;\npublic class AppTest {}\n',
    ...extra,
  });
}

test('java: resolves classes, nested classes, static members and package wildcards to real files', () => {
  const scan = scanRepo(javaRepo());
  const app = scan.files.find((f) => f.path === 'src/main/java/com/acme/App.java');
  assert.equal(app.package, 'com.acme');
  const resolved = app.imports.filter((i) => i.resolved).map((i) => `${i.spec} -> ${i.resolved.split('/').slice(-2).join('/')}`).sort();
  assert.deepEqual(resolved, [
    'com.acme.model.* -> model/Order.java',
    'com.acme.model.* -> model/User.java',
    'com.acme.util.Strings -> util/Strings.java',
    'com.acme.util.Strings.Inner -> util/Strings.java',
    'com.acme.util.Strings.shout -> util/Strings.java',
  ]);
  const dropped = app.imports.filter((i) => !i.resolved).map((i) => i.spec);
  assert.ok(dropped.includes('java.util.List') && dropped.includes('com.other.Missing'), 'JDK and unknown types are dropped, not guessed');
  assert.ok(!app.imports.some((i) => /ghost/i.test(i.spec)), 'commented-out imports are ignored');
});

test('java: Maven dependencies become external nodes only when actually imported (tests and JDK excluded)', () => {
  const scan = scanRepo(javaRepo());
  assert.deepEqual(externals(scan), ['org.apache.commons:commons-lang3']);
  const ext = scan.externals[0];
  assert.equal(ext.version, '3.14.0');
  assert.equal(ext.declaredAt.file, 'pom.xml');
  assert.equal(scan.manifests.find((m) => m.type === 'maven').dependencies[0], 'org.apache.commons:commons-lang3');
});

test('java: Gradle dependencies, and an import whose package is not the groupId is dropped rather than guessed', () => {
  const root = repo({
    'build.gradle': "dependencies {\n  implementation 'org.apache.commons:commons-lang3:3.14.0'\n  implementation 'com.google.guava:guava:33.0.0-jre'\n  testImplementation 'junit:junit:4.13'\n}\n",
    'src/main/java/app/Main.java': 'package app;\nimport org.apache.commons.lang3.StringUtils;\nimport com.google.common.collect.ImmutableList;\npublic class Main { public static void main(String[] a) {} }\n',
  });
  const scan = scanRepo(root);
  assert.deepEqual(externals(scan), ['org.apache.commons:commons-lang3'], 'guava\'s package (com.google.common) differs from its groupId, so it is not guessed');
  assert.equal(scan.externals[0].declaredAt.file, 'build.gradle');
});

test('java: packages are the unit of architecture, an entry point is found, and the result validates', () => {
  const root = javaRepo();
  const arch = generate(scanRepo(root));
  assert.deepEqual(validate(arch, root).errors, []);
  const internal = arch.nodes.filter((n) => !n.external);
  assert.equal(internal.length, 3, 'com.acme, com.acme.util and com.acme.model packages (tests excluded)');
  assert.ok(internal.some((n) => n.kind === 'entry'), 'the package holding the main method is the entry');
  assert.ok(arch.edges.some((e) => e.kind === 'imports' && /model/.test(e.to)), 'com.acme -> com.acme.model through the wildcard import');
  assert.ok(arch.nodes.some((n) => n.external && /commons-lang3/.test(n.label)));
});

test('java: a package named "samples" or "demo" inside a JVM source root is not an examples folder', () => {
  const root = repo({
    'pom.xml': '<project/>',
    'src/main/java/org/acme/samples/Petclinic.java': 'package org.acme.samples;\nimport org.acme.samples.owner.Owner;\npublic class Petclinic { public static void main(String[] a) {} }\n',
    'src/main/java/org/acme/samples/owner/Owner.java': 'package org.acme.samples.owner;\npublic class Owner {}\n',
    'examples/Demo.java': 'public class Demo {}\n', // a real examples folder outside the source root is still skipped
  });
  const arch = generate(scanRepo(root));
  const files = arch.nodes.flatMap((n) => n.sources.map((s) => s.path));
  assert.ok(files.some((p) => p.endsWith('Petclinic.java')), 'source under org/acme/samples is kept');
  assert.ok(!files.some((p) => p.startsWith('examples/')));
  assert.match(arch.project.notes.join(' '), /1 examples file/);
  assert.ok(arch.edges.length >= 1, 'the package edge exists');
});

test('rust: mod declarations and use paths resolve through the module tree (crate, self, super, braces, aliases)', () => {
  const root = repo({
    'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\nanyhow = "1.0"\n\n[dev-dependencies]\ncriterion = "0.5"\n',
    'src/main.rs': 'mod config;\nmod net;\nmod missing;\nuse crate::config::Settings;\nuse crate::net::client::Client;\nuse serde::Serialize;\nuse anyhow::Result;\nuse std::collections::HashMap;\nuse rand::Rng;\nfn main() {}\n',
    'src/config.rs': 'use super::net::client::Client;\nuse crate::net::{client::Client as C2, server::{self, Server}};\npub struct Settings;\n',
    'src/net/mod.rs': 'pub mod client;\npub mod server;\n',
    'src/net/client.rs': 'use super::server::Server;\nuse self::helper::Thing;\npub struct Client;\n',
    'src/net/server.rs': 'pub struct Server;\n',
  });
  const scan = scanRepo(root);
  const main = scan.files.find((f) => f.path === 'src/main.rs').imports;
  const got = (spec) => main.filter((i) => i.spec === spec).map((i) => i.resolved);
  assert.deepEqual(got('mod:config'), ['src/config.rs']);
  assert.deepEqual(got('mod:net'), ['src/net/mod.rs'], 'a directory module is found through mod.rs');
  assert.deepEqual(got('mod:missing'), [null], 'a mod declaration without a file is dropped');
  assert.deepEqual(got('crate::config::Settings'), ['src/config.rs'], 'the item name is trimmed to its module');
  assert.deepEqual(got('crate::net::client::Client'), ['src/net/client.rs']);
  assert.deepEqual(got('std::collections::HashMap'), [null]);
  assert.deepEqual(got('rand::Rng'), [null], 'a crate that is not declared in Cargo.toml is dropped, not guessed');
  assert.deepEqual(externals(scan), ['anyhow', 'serde'], 'declared [dependencies] only (dev-dependencies excluded, unused ones absent)');
  assert.equal(scan.externals.find((e) => e.name === 'serde').version, '1');

  const cfg = scan.files.find((f) => f.path === 'src/config.rs').imports.map((i) => `${i.spec}=${i.resolved}`);
  assert.ok(cfg.includes('super::net::client::Client=src/net/client.rs'), 'super:: from a top-level module reaches the crate root');
  assert.ok(cfg.includes('crate::net::client::Client=src/net/client.rs'), 'braces and "as" aliases expand to plain paths');
  assert.ok(cfg.includes('crate::net::server=src/net/server.rs'), 'nested {self, Server} resolves both');
  assert.ok(cfg.includes('crate::net::server::Server=src/net/server.rs'));
  const client = scan.files.find((f) => f.path === 'src/net/client.rs').imports;
  assert.equal(client.find((i) => i.spec === 'super::server::Server').resolved, 'src/net/server.rs');
  assert.equal(client.find((i) => i.spec === 'self::helper::Thing').resolved, null, 'self:: into a module that does not exist is dropped');
  assert.ok(scan.entryPoints.some((e) => e.path === 'src/main.rs'));
});

test('rust: workspace crates import each other by crate name, and library crates get a root entry', () => {
  const root = repo({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/core/Cargo.toml': '[package]\nname = "app-core"\n',
    'crates/core/src/lib.rs': 'pub mod engine;\npub mod util;\n',
    'crates/core/src/engine.rs': 'use crate::util::clamp;\npub struct Engine;\n',
    'crates/core/src/util.rs': 'pub fn clamp() {}\n',
    'crates/cli/Cargo.toml': '[package]\nname = "app-cli"\n\n[dependencies]\napp-core = { path = "../core" }\nclap = "4"\n',
    'crates/cli/src/main.rs': 'use app_core::engine::Engine;\nuse app_core::util;\nuse clap::Parser;\nfn main() {}\n',
  });
  const scan = scanRepo(root);
  const cli = scan.files.find((f) => f.path === 'crates/cli/src/main.rs').imports;
  assert.equal(cli.find((i) => i.spec === 'app_core::engine::Engine').resolved, 'crates/core/src/engine.rs', 'a use of another workspace crate resolves into that crate');
  assert.equal(cli.find((i) => i.spec === 'app_core::util').resolved, 'crates/core/src/util.rs');
  assert.equal(scan.files.find((f) => f.path === 'crates/core/src/engine.rs').imports[0].resolved, 'crates/core/src/util.rs');
  assert.deepEqual(externals(scan), ['clap'], 'workspace members are code in this repository, not external dependencies');
  assert.ok(scan.entryPoints.some((e) => e.path === 'crates/cli/src/main.rs'), 'a binary crate deeper than the root is still an entry point');
  const arch = generate(scan);
  assert.ok(arch.edges.some((e) => e.kind === 'imports'), 'cross-crate edges exist');
});

test('rust: use-tree expansion', async () => {
  const { expandUse } = await import('../skills/repo-architecture/scripts/lib/core/lang-rust.mjs');
  assert.deepEqual(expandUse('a::b::C'), ['a::b::C']);
  assert.deepEqual(expandUse('a::{b, c::{d, self}, e as f}'), ['a::b', 'a::c::d', 'a::c', 'a::e']);
  assert.deepEqual(expandUse('crate::m::*'), ['crate::m']);
  assert.deepEqual(expandUse('::std::fmt'), ['std::fmt']);
  assert.deepEqual(expandUse('a::{'), [], 'malformed input never throws');
});

test('rust: the generated architecture validates', () => {
  const root = repo({
    'Cargo.toml': '[package]\nname = "solo"\n[dependencies]\nserde = "1"\n',
    'src/lib.rs': 'pub mod shapes;\nuse serde::Serialize;\n',
    'src/shapes.rs': 'pub struct Circle;\n',
  });
  const scan = scanRepo(root);
  const arch = generate(scan);
  assert.deepEqual(validate(arch, root).errors, []);
  assert.ok(scan.entryPoints.some((e) => e.path === 'src/lib.rs' && /Rust library/.test(e.reason)));
});
