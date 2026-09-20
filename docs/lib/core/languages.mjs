// Language plug-ins. Each language that has an import graph is one entry in PLUGINS; the scanner knows nothing else about it.
//
// A plug-in is a plain object:
//
//   name          unique key
//   exts          file extensions it owns (lowercase, no dot)
//   langNames     { ext: 'Display name' } for the language statistics
//   packageUnit   true when a directory / package (not a single file) is the natural unit of the diagram
//   parse(text, ext)  -> { imports: [{ spec, line, names }], package?: string, symbols?: [{ name, line }] }
//                        private data for the resolver may be kept on `imp._` (removed after resolution)
//   prepare({ files, allPaths, read })
//                     -> { state, deps?, manifests?, workspaces? }   run once per scan, after every file is parsed
//        deps         [{ name, version, file, line }]  declared third-party packages
//        manifests    [{ file, type, dependencies: [name] }]
//        workspaces   [{ name, dir, kind, manifest }]  sub-packages of a monorepo
//   resolve(imp, state, file) -> { files?: [path], external?: name }
//                        `files` must exist in the repository; an import that resolves to nothing returns {} and is dropped.
//                        `file` is the importing file ({ path, _text, package, ... }).
//   entry(file, state)        -> reason string when the file is a program entry point, else null (tests are skipped by the caller)
//   entryFallback(files, state) -> [{ path, reason }]   consulted only when no entry point was found at all
//
// Nothing is guessed: a plug-in only reports a file that exists, and an external only when a manifest declares it.
// Adding a language = one new file that exports a plug-in, plus one line below.
import { rustImports, buildRustContext, resolveRustImport, rustDependencies } from './lang-rust.mjs';
import { javaImports, javaPackage, javaSymbols, buildJavaIndex, resolveJavaImport, parseJavaDeps, matchJavaDependency, hasJavaMain } from './lang-java.mjs';
import { kotlinImports, kotlinPackage, kotlinSymbols, hasKotlinMain } from './lang-kotlin.mjs';

const byDepth = (a, b) => a.path.split('/').length - b.path.split('/').length;

/** Java and Kotlin share one class index, so a Kotlin file can import a Java class and the other way round. */
export const jvm = {
  name: 'jvm',
  exts: ['java', 'kt'],
  langNames: { java: 'Java', kt: 'Kotlin' },
  packageUnit: true,
  alwaysPrepare: true, // pom.xml / build.gradle dependencies are read even when no Java file was scanned
  parse(text, ext) {
    return ext === 'java'
      ? { imports: javaImports(text), package: javaPackage(text), symbols: javaSymbols(text) }
      : { imports: kotlinImports(text), package: kotlinPackage(text), symbols: kotlinSymbols(text) };
  },
  prepare({ files, allPaths, read }) {
    const deps = parseJavaDeps(read, allPaths);
    const manifests = [...new Set(deps.map((d) => d.file))].map((file) => ({
      file, type: file.endsWith('pom.xml') ? 'maven' : 'gradle', dependencies: deps.filter((d) => d.file === file).map((d) => d.name),
    }));
    return { state: { index: buildJavaIndex(files), deps }, deps, manifests };
  },
  resolve(imp, st, file) {
    const hits = resolveJavaImport(imp.java ? imp : { ...imp, java: { isStatic: false, wildcard: false } }, st.index, file.path);
    if (hits.length) return { files: hits };
    const dep = matchJavaDependency(imp.spec, st.deps);
    return dep ? { external: dep.name } : {};
  },
  entry(file) {
    if (file.path.endsWith('.java') && hasJavaMain(file._text)) return 'Java main method or Spring Boot application';
    if (file.path.endsWith('.kt') && hasKotlinMain(file._text)) return 'Kotlin main function';
    return null;
  },
};

export const rust = {
  name: 'rust',
  exts: ['rs'],
  langNames: { rs: 'Rust' },
  packageUnit: false,
  alwaysPrepare: true, // Cargo workspaces are discovered from Cargo.toml files
  parse: (text) => ({ imports: rustImports(text) }),
  prepare({ allPaths, read }) {
    const ctx = buildRustContext(allPaths, read);
    return {
      state: ctx,
      deps: rustDependencies(ctx),
      workspaces: ctx.crates.filter((c) => c.dir).map((c) => ({ name: c.name, dir: c.dir, kind: 'cargo', manifest: c.file })),
    };
  },
  resolve(imp, ctx, file) {
    const r = resolveRustImport(imp, ctx, file.path);
    if (r.file) return { files: [r.file] };
    return r.external ? { external: r.external } : {};
  },
  entry: (file) => (/(^|\/)src\/main\.rs$/.test(file.path) ? 'Rust binary crate (main.rs)' : null),
  entryFallback(files) {
    const lib = files.filter((f) => /(^|\/)src\/lib\.rs$/.test(f.path) && !f.isTest).sort(byDepth)[0];
    return lib ? [{ path: lib.path, reason: 'Rust library crate root (lib.rs)' }] : [];
  },
};

export const PLUGINS = [jvm, rust];

export const PLUGIN_BY_EXT = Object.fromEntries(PLUGINS.flatMap((p) => p.exts.map((e) => [e, p])));
/** Extensions whose directory (package) is the diagram unit, for the generator. */
export const PACKAGE_EXTS = new Set(PLUGINS.filter((p) => p.packageUnit).flatMap((p) => p.exts));
export const PLUGIN_LANG_NAMES = Object.assign({}, ...PLUGINS.map((p) => p.langNames));
