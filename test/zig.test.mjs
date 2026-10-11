// Zig import graph: relative @import paths, build.zig modules and build.zig.zon dependencies; nothing guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zigImports, parseZon, parseBuildModules } from '../skills/repo-architecture/scripts/lib/core/lang-zig.mjs';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { repo, imports, externals } from './helpers.mjs';

test('zig: @import("...") calls are found, but not in comments or multiline strings', () => {
  const src = [
    'const std = @import("std");',
    'const util = @import("util.zig");',
    '// const gone = @import("gone.zig");',
    'const s =',
    '    \\\\ @import("in_string.zig")', // Zig's multiline string line prefix is two backslashes
    ';',
    'const x = @import("sub/x.zig"); // @import("trailing.zig")',
    'const c = @cImport(@cInclude("stdio.h"));',
  ].join('\n');
  assert.deepEqual(zigImports(src).map((i) => [i.spec, i.line]), [['std', 1], ['util.zig', 2], ['sub/x.zig', 7]]);
});

test('zig: build.zig.zon dependencies are read at the first nesting level only, with the line of each', () => {
  const zon = [
    '.{',
    '    .name = .demo,',
    '    .version = "0.1.0",',
    '    .dependencies = .{',
    '        .zlib = .{',
    '            .url = "https://example.com/zlib.tar.gz",',
    '            .hash = "abc",',
    '        },',
    '        .@"known-folders" = .{ .path = "../kf" },',
    '    },',
    '    .paths = .{ "src" },',
    '}',
  ].join('\n');
  assert.deepEqual(parseZon(zon), [{ name: 'zlib', line: 5 }, { name: 'known-folders', line: 9 }]);
  assert.deepEqual(parseZon('.{ .name = .x }'), []);
});

test('zig: addModule names map to the file b.path() points at', () => {
  const b = 'pub fn build(b: *std.Build) void {\n  const m = b.addModule("core", .{ .root_source_file = b.path("src/core.zig") });\n}\n';
  assert.deepEqual([...parseBuildModules(b)], [['core', 'src/core.zig']]);
});

const project = () => repo({
  'build.zig.zon': '.{\n    .name = .demo,\n    .dependencies = .{\n        .zlib = .{ .url = "u", .hash = "h" },\n        .unused = .{ .url = "u", .hash = "h" },\n    },\n}\n',
  'build.zig': 'const std = @import("std");\npub fn build(b: *std.Build) void {\n    _ = b.addModule("core", .{ .root_source_file = b.path("src/core.zig") });\n}\n',
  'src/main.zig': 'const std = @import("std");\nconst core = @import("core");\nconst util = @import("util.zig");\nconst z = @import("zlib");\nconst missing = @import("nope.zig");\nconst h = @import("helpers/h.zig");\npub fn main() void {}\n',
  'src/core.zig': 'const util = @import("util.zig");\npub const x = 1;\n',
  'src/util.zig': 'pub const u = 1;\n',
  'src/helpers/h.zig': 'const up = @import("../util.zig");\n',
  'src/main_test.zig': 'const m = @import("main.zig");\ntest "x" {}\n',
});

test('zig: relative paths, build.zig modules and declared dependencies resolve; std, missing files and undeclared names are dropped', () => {
  const scan = scanRepo(project());
  const main = Object.fromEntries(Object.entries(imports(scan, 'src/main.zig')).filter(([, v]) => v));
  assert.deepEqual(main, { core: 'src/core.zig', 'util.zig': 'src/util.zig', 'helpers/h.zig': 'src/helpers/h.zig' });
  assert.equal(imports(scan, 'src/main.zig')['nope.zig'] || null, null, 'a file that does not exist');
  assert.equal(imports(scan, 'src/helpers/h.zig')['../util.zig'], 'src/util.zig', 'parent-relative');
  const ext = externals(scan);
  assert.ok(ext.includes('zlib'), 'declared and imported: ' + ext);
  assert.ok(!ext.includes('unused'), 'declared but never imported');
});

test('zig: pub fn main is the entry point, and the graph generates and validates', () => {
  const root = project();
  const scan = scanRepo(root);
  assert.ok(scan.entryPoints.some((e) => e.path === 'src/main.zig' && /main/.test(e.reason)), JSON.stringify(scan.entryPoints));
  const arch = generate(scan);
  assert.deepEqual(validate(arch, root).errors, []);
  assert.ok(scan.stats.languages.Zig >= 5);
});
