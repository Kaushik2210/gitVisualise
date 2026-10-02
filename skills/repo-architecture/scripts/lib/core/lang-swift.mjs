// Swift: `import Module` names a Swift Package Manager target, not a file, so resolution goes through the
// targets a Package.swift manifest actually declares. A target is a directory (Sources/<Target>/...), matching
// SPM's own convention. System frameworks (Foundation, SwiftUI, UIKit, ...) and anything else not declared as
// either a local target or a dependency's product are dropped, never guessed.
import * as posix from './posix.mjs';

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

// `import Foundation`, `@testable import MyModule`, `import struct Foundation.Date` (the module is still the
// first identifier; the optional kind keyword and any dotted submodule/symbol path are not part of it).
const IMPORT_RE = /^[ \t]*(?:@testable\s+)?import\s+(?:(?:typealias|struct|class|enum|protocol|func|var|let)\s+)?([A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)*\s*$/gm;

export function swiftImports(text) {
  const out = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text))) out.push({ spec: m[1], line: lineOf(text, m.index), names: [] });
  return out;
}

const TARGET_RE = /\.(?:target|executableTarget|testTarget)\s*\(\s*name:\s*"([^"]+)"/g;
const PACKAGE_RE = /\.package\s*\(([^)]*)\)/g;
const PRODUCT_DEP_RE = /\.product\s*\(\s*name:\s*"([^"]+)"\s*,\s*package:\s*"([^"]+)"\s*\)/g;

/** Package.swift -> local target names, declared dependency packages, and which product belongs to which package. */
export function parsePackageManifest(text) {
  const targets = new Set();
  let m;
  TARGET_RE.lastIndex = 0;
  while ((m = TARGET_RE.exec(text))) targets.add(m[1]);

  const packages = [];
  PACKAGE_RE.lastIndex = 0;
  while ((m = PACKAGE_RE.exec(text))) {
    const args = m[1];
    const nameM = /name:\s*"([^"]+)"/.exec(args);
    const urlM = /url:\s*"([^"]+)"/.exec(args);
    const pathM = /path:\s*"([^"]+)"/.exec(args);
    const src = (urlM && urlM[1]) || (pathM && pathM[1]) || '';
    const inferred = src.replace(/\.git$/, '').split('/').filter(Boolean).pop() || '';
    const name = (nameM && nameM[1]) || inferred;
    if (name) packages.push(name);
  }

  const productToPackage = new Map();
  PRODUCT_DEP_RE.lastIndex = 0;
  while ((m = PRODUCT_DEP_RE.exec(text))) productToPackage.set(m[1], m[2]);

  return { targets, packages: [...new Set(packages)], productToPackage };
}

export const hasSwiftMain = (text) => /^@main\b/m.test(text);

export const swift = {
  name: 'swift',
  exts: ['swift'],
  langNames: { swift: 'Swift' },
  packageUnit: true,
  manifests: ['Package\\.swift'],
  parse: (text) => ({ imports: swiftImports(text) }),
  prepare({ files, allPaths, read }) {
    const manifestPath = allPaths.find((p) => /(^|\/)Package\.swift$/.test(p));
    const manifestText = manifestPath ? read(manifestPath) : '';
    const { targets, packages, productToPackage } = parsePackageManifest(manifestText || '');
    const filesByTarget = new Map();
    for (const t of targets) {
      const prefix = `Sources/${t}/`;
      filesByTarget.set(t, files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path));
    }
    const deps = packages.map((name) => ({ name, version: null, file: manifestPath, line: 1 }));
    const manifests = manifestPath ? [{ file: manifestPath, type: 'spm', dependencies: packages }] : [];
    return { state: { targets, packages, productToPackage, filesByTarget }, deps, manifests };
  },
  resolve(imp, st, file) {
    if (st.targets.has(imp.spec)) {
      const hits = (st.filesByTarget.get(imp.spec) || []).filter((p) => p !== file.path);
      return hits.length ? { files: hits } : {};
    }
    const pkg = st.productToPackage.get(imp.spec) || st.packages.find((p) => p === imp.spec);
    return pkg ? { external: pkg } : {};
  },
  entry(file) {
    if (posix.basename(file.path) === 'main.swift') return 'Swift main.swift (top-level executable entry)';
    if (hasSwiftMain(file._text)) return '@main entry point';
    return null;
  },
};
