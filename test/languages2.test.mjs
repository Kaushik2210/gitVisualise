// Import graphs for C#, Ruby, PHP, C/C++ and Dart. Every test includes imports that must stay unresolved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { repo, imports, externals } from './helpers.mjs';

const resolvedOf = (scan, file, spec) => scan.files.find((f) => f.path === file).imports.filter((i) => i.spec === spec).map((i) => i.resolved);

test('csharp: using directives resolve through declared namespaces and types, only to files that are actually used', () => {
  const root = repo({
    'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />\n  </ItemGroup>\n</Project>\n',
    'App/Program.cs': [
      'using System;', 'using System.Linq;', 'using Newtonsoft.Json;', 'using App.Services;', 'using static App.Util.Helpers;', 'using Person = App.Models.User;',
      'using (var x = new Foo()) { }', 'using var y = new Bar();',
      'class Program { static void Main(string[] args) { var s = new UserService(); } }', '',
    ].join('\n'),
    'App/Services/UserService.cs': 'namespace App.Services;\npublic class UserService { }\n',
    'App/Services/Unused.cs': 'namespace App.Services;\npublic class Unused { }\n',
    'App/Models/User.cs': 'namespace App.Models\n{\n    public class User { }\n}\n',
    'App/Util/Helpers.cs': 'namespace App.Util\n{\n    public static class Helpers { }\n}\n',
  });
  const scan = scanRepo(root);
  const p = 'App/Program.cs';
  assert.deepEqual(resolvedOf(scan, p, 'App.Services'), ['App/Services/UserService.cs'], 'only the file whose type is mentioned, not Unused.cs');
  assert.deepEqual(resolvedOf(scan, p, 'App.Util.Helpers'), ['App/Util/Helpers.cs'], 'using static names a type');
  assert.deepEqual(resolvedOf(scan, p, 'App.Models.User'), ['App/Models/User.cs'], 'an alias names a type');
  assert.deepEqual(resolvedOf(scan, p, 'System'), [null]);
  assert.deepEqual(resolvedOf(scan, p, 'System.Linq'), [null]);
  assert.ok(!scan.files.find((f) => f.path === p).imports.some((i) => i.spec === 'var'), 'using statements are not directives');
  assert.deepEqual(externals(scan), ['Newtonsoft.Json'], 'a NuGet package only when the csproj declares it');
  assert.ok(scan.entryPoints.some((e) => e.path === p));
  const arch = generate(scan);
  assert.deepEqual(validate(arch, root).errors, []);
  assert.ok(arch.edges.some((e) => e.kind === 'imports'), 'the namespaces become edges between package-level components');
});

test('ruby: require_relative and require resolve to files on the load path, gems only when declared', () => {
  const root = repo({
    Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\ngem 'nokogiri'\n",
    'lib/mylib.rb': ["require_relative 'mylib/parser'", "require 'mylib/version'", "require 'json'", "require 'nokogiri'", "require 'rails/all'", "require_relative 'nothing'", 'require "dyn/#{name}"', 'module Mylib; end', ''].join('\n'),
    'lib/mylib/parser.rb': "require_relative '../mylib'\nclass Mylib::Parser; end\n",
    'lib/mylib/version.rb': "module Mylib\n  VERSION = '1'\nend\n",
    'bin/run.rb': "#!/usr/bin/env ruby\nrequire 'mylib'\nMylib\n",
  });
  const scan = scanRepo(root);
  const m = 'lib/mylib.rb';
  assert.deepEqual(resolvedOf(scan, m, 'mylib/parser'), ['lib/mylib/parser.rb']);
  assert.deepEqual(resolvedOf(scan, m, 'mylib/version'), ['lib/mylib/version.rb']);
  assert.deepEqual(resolvedOf(scan, m, 'json'), [null], 'the standard library is not a file of this repo');
  assert.deepEqual(resolvedOf(scan, m, 'nothing'), [null], 'a missing relative file is dropped');
  assert.ok(!scan.files.find((f) => f.path === m).imports.some((i) => i.spec.includes('dyn/')), 'interpolated requires are not static');
  assert.deepEqual(resolvedOf(scan, 'bin/run.rb', 'mylib'), ['lib/mylib.rb'], 'lib is on the load path');
  assert.deepEqual(externals(scan), ['nokogiri', 'rails'], 'declared gems become externals (rails/all -> rails), json does not');
  assert.ok(scan.entryPoints.some((e) => e.path === 'bin/run.rb'));
  assert.deepEqual(validate(generate(scan), root).errors, []);
});

test('php: use statements resolve through declared classes and PSR-4, group use expands, require follows literal paths', () => {
  const root = repo({
    'composer.json': JSON.stringify({ require: { php: '>=8.1', 'monolog/monolog': '^3.0', 'ext-json': '*' }, autoload: { 'psr-4': { 'App\\': 'src/' } } }),
    'src/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
    'src/Models/Group.php': '<?php\nnamespace App\\Models;\nclass Group {}\n',
    'src/Services/Mailer.php': [
      '<?php', 'namespace App\\Services;', 'use App\\Models\\User;', 'use App\\Models\\{Group, Missing as M};', 'use Monolog\\Logger;',
      'use Illuminate\\Support\\Str;', 'use App\\Nope\\Nothing;', "require __DIR__ . '/../helpers.php';", "require_once 'vendor/autoload.php';",
      'class Mailer { use Loggable; public function f() { return function () use ($x) {}; } }', '',
    ].join('\n'),
    'src/helpers.php': '<?php\nfunction helper() {}\n',
    'public/index.php': "<?php\nuse App\\Services\\Mailer;\n(new Mailer);\n",
  });
  const scan = scanRepo(root);
  const mail = 'src/Services/Mailer.php';
  assert.deepEqual(resolvedOf(scan, mail, 'App\\Models\\User'), ['src/Models/User.php']);
  assert.deepEqual(resolvedOf(scan, mail, 'App\\Models\\Group'), ['src/Models/Group.php'], 'group use expands');
  assert.deepEqual(resolvedOf(scan, mail, 'App\\Models\\Missing'), [null]);
  assert.deepEqual(resolvedOf(scan, mail, 'App\\Nope\\Nothing'), [null]);
  assert.deepEqual(resolvedOf(scan, mail, 'Illuminate\\Support\\Str'), [null], 'a framework class is not guessed');
  assert.deepEqual(resolvedOf(scan, mail, '/../helpers.php'), ['src/helpers.php'], '__DIR__ . path');
  assert.deepEqual(resolvedOf(scan, mail, 'vendor/autoload.php'), [null]);
  assert.deepEqual(externals(scan), ['monolog/monolog'], 'a Composer package only when the namespace equals its vendor or name');
  assert.ok(!scan.files.find((f) => f.path === mail).imports.some((i) => i.spec === 'Loggable' || i.spec === '$x'), 'trait use and closure use are not imports');
  assert.ok(scan.entryPoints.some((e) => e.path === 'public/index.php'));
  assert.deepEqual(resolvedOf(scan, 'public/index.php', 'App\\Services\\Mailer'), [mail]);
  assert.deepEqual(validate(generate(scan), root).errors, []);
});

test('php: PSR-4 resolves even when the class is only findable through the autoload map', () => {
  const root = repo({
    'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Acme\\Lib\\': 'lib/core/' } } }),
    'lib/core/Thing/Widget.php': '<?php\n// no namespace declared here on purpose\nclass Widget {}\n',
    'app.php': "<?php\nuse Acme\\Lib\\Thing\\Widget;\nuse Acme\\Lib\\Thing\\Gadget;\n",
  });
  const scan = scanRepo(root);
  assert.deepEqual(resolvedOf(scan, 'app.php', 'Acme\\Lib\\Thing\\Widget'), ['lib/core/Thing/Widget.php']);
  assert.deepEqual(resolvedOf(scan, 'app.php', 'Acme\\Lib\\Thing\\Gadget'), [null], 'the PSR-4 path must exist');
});

test('c/c++: quoted includes resolve relative to the file and through CMake include directories; system headers are dropped', () => {
  const root = repo({
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.10)\nproject(demo)\ninclude_directories(include)\ntarget_include_directories(demo PUBLIC ${PROJECT_SOURCE_DIR}/third_party ${SOME_VAR}/x)\nadd_executable(demo src/main.cpp)\n',
    'include/mylib/util.h': '#pragma once\nint util();\n',
    'include/mylib/core.hpp': '#pragma once\n#include "util.h"\n#include <mylib/util.h>\nstruct Core {};\n',
    'third_party/vendored.h': '#pragma once\n',
    'src/main.cpp': ['#include <iostream>', '#include <vector>', '#include "local.h"', '#include "mylib/core.hpp"', '#include <mylib/util.h>', '#include "vendored.h"', '#include "missing.h"', 'int main() { return 0; }', ''].join('\n'),
    'src/local.h': '#pragma once\n',
  });
  const scan = scanRepo(root);
  const m = 'src/main.cpp';
  assert.deepEqual(resolvedOf(scan, m, 'local.h'), ['src/local.h'], 'relative to the including file');
  assert.deepEqual(resolvedOf(scan, m, 'mylib/core.hpp'), ['include/mylib/core.hpp'], 'through include_directories');
  assert.deepEqual(resolvedOf(scan, m, 'mylib/util.h'), ['include/mylib/util.h'], 'an angle include is followed only when a project include dir holds it');
  assert.deepEqual(resolvedOf(scan, m, 'vendored.h'), ['third_party/vendored.h'], 'through ${PROJECT_SOURCE_DIR}/third_party');
  assert.deepEqual(resolvedOf(scan, m, 'iostream'), [null]);
  assert.deepEqual(resolvedOf(scan, m, 'missing.h'), [null]);
  assert.deepEqual(resolvedOf(scan, 'include/mylib/core.hpp', 'util.h'), ['include/mylib/util.h']);
  assert.ok(scan.entryPoints.some((e) => e.path === m));
  assert.deepEqual(validate(generate(scan), root).errors, []);
});

test('dart: package: imports resolve to lib/ of packages in the repository, dart: is ignored, declared packages are external', () => {
  const root = repo({
    'pubspec.yaml': 'name: my_app\ndescription: demo\ndependencies:\n  http: ^1.0.0 # web\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n',
    'lib/main.dart': ["import 'dart:async';", "import 'package:my_app/src/foo.dart';", "import 'bar.dart';", "import 'package:http/http.dart' as http;", "import 'package:unknown/x.dart';", "import 'package:flutter/material.dart';", "export 'src/foo.dart';", "part 'main.g.dart';", 'void main() {}', ''].join('\n'),
    'lib/src/foo.dart': 'class Foo {}\n',
    'lib/bar.dart': 'class Bar {}\n',
  });
  const scan = scanRepo(root);
  const m = 'lib/main.dart';
  assert.deepEqual(resolvedOf(scan, m, 'package:my_app/src/foo.dart'), ['lib/src/foo.dart']);
  assert.deepEqual(resolvedOf(scan, m, 'bar.dart'), ['lib/bar.dart']);
  assert.deepEqual(resolvedOf(scan, m, 'src/foo.dart'), ['lib/src/foo.dart'], 'export');
  assert.deepEqual(resolvedOf(scan, m, 'main.g.dart'), [null], 'a part file that is not in the repository is dropped');
  assert.deepEqual(resolvedOf(scan, m, 'package:unknown/x.dart'), [null]);
  assert.ok(!scan.files.find((f) => f.path === m).imports.some((i) => i.spec.startsWith('dart:')));
  assert.deepEqual(externals(scan), ['flutter', 'http'], 'declared packages are external; an undeclared one is not');
  assert.ok(scan.entryPoints.some((e) => e.path === m));
  assert.deepEqual(validate(generate(scan), root).errors, []);
});

test('dart: packages of a monorepo resolve to each other', () => {
  const root = repo({
    'packages/core/pubspec.yaml': 'name: core\n',
    'packages/core/lib/core.dart': 'class Core {}\n',
    'packages/app/pubspec.yaml': 'name: app\ndependencies:\n  core:\n    path: ../core\n',
    'packages/app/lib/main.dart': "import 'package:core/core.dart';\nimport 'package:core/missing.dart';\nvoid main() {}\n",
  });
  const scan = scanRepo(root);
  assert.deepEqual(resolvedOf(scan, 'packages/app/lib/main.dart', 'package:core/core.dart'), ['packages/core/lib/core.dart']);
  assert.deepEqual(resolvedOf(scan, 'packages/app/lib/main.dart', 'package:core/missing.dart'), [null]);
});

test('new languages: test files by convention are not drawn, and language names are reported', () => {
  const root = repo({
    'lib/a.rb': "require_relative 'b'\n",
    'lib/b.rb': 'class B; end\n',
    'lib/b_spec.rb': "require_relative 'b'\n",
    'App.Tests/UnitTest1.cs': 'namespace App.Tests { public class UnitTest1 {} }\n',
    'src/x_test.cc': '#include "x.h"\n',
    'src/x.h': '#pragma once\n',
  });
  const scan = scanRepo(root);
  const isTest = (p) => scan.files.find((f) => f.path === p).isTest;
  assert.equal(isTest('lib/b_spec.rb'), true);
  assert.equal(isTest('App.Tests/UnitTest1.cs'), true);
  assert.equal(isTest('src/x_test.cc'), true);
  assert.equal(isTest('lib/a.rb'), false);
  assert.ok(scan.stats.languages.Ruby >= 2 && scan.stats.languages['C#'] === 1 && scan.stats.languages['C++'] >= 1);
});
