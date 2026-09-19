// Java support for the scanner: import parsing, resolution to files inside the repository, and Maven/Gradle
// dependencies. Pure (no Node APIs), so it runs in the CLI and in the browser.
//
// Resolution rule: an import is only resolved when it names a class (or a package) that exists in the repository.
// Anything else is dropped rather than guessed. JDK classes are never external nodes.

const lineOf = (text, idx) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

const JDK = /^(java|javax|jdk|sun|com\.sun)\./;

/** import a.b.C;  import a.b.*;  import static a.b.C.member;  import static a.b.C.*; */
export function javaImports(text) {
  const out = [];
  const re = /^[ \t]*import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({ spec: m[2] + (m[3] || ''), line: lineOf(text, m.index), names: [], java: { isStatic: !!m[1], wildcard: !!m[3] } });
  }
  return out;
}

export function javaPackage(text) {
  const m = /^\s*package\s+([\w.]+)\s*;/m.exec(text);
  return m ? m[1] : '';
}

export function javaSymbols(text) {
  const out = [];
  const re = /^(?:(?:public|protected|private|final|abstract|static|sealed|non-sealed)\s+)*(class|interface|enum|record|@interface)\s+(\w+)/gm;
  let m;
  while ((m = re.exec(text)) && out.length < 12) out.push({ name: m[2], line: lineOf(text, m.index) });
  return out;
}

/** Index of top-level types by fully qualified name, and of files by package. Paths are repository-relative. */
export function buildJavaIndex(files) {
  const byClass = new Map();
  const byPackage = new Map();
  for (const f of files) {
    if (!/\.(java|kt)$/.test(f.path)) continue;
    const cls = f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.(java|kt)$/, '');
    const names = new Set([...(f.path.endsWith('.java') ? [cls] : []), ...(f.symbols || []).map((s) => s.name)]);
    for (const name of names) {
      const fqcn = f.package ? `${f.package}.${name}` : name;
      if (!byClass.has(fqcn)) byClass.set(fqcn, f.path);
    }
    if (!byPackage.has(f.package || '')) byPackage.set(f.package || '', []);
    byPackage.get(f.package || '').push(f.path);
  }
  return { byClass, byPackage };
}

/**
 * Resolves one import to the repository files it refers to (an array: a package wildcard names several files).
 * Nested classes and static members are handled by trimming trailing segments until a known class matches.
 */
export function resolveJavaImport(imp, index, fromPath) {
  const { isStatic, wildcard } = imp.java;
  const spec = wildcard ? imp.spec.slice(0, -2) : imp.spec;
  if (wildcard && !isStatic) {
    const files = index.byPackage.get(spec);
    if (files) return files.filter((p) => p !== fromPath);
    // "import a.b.C.*;" imports the nested types of a class
  }
  const parts = spec.split('.');
  for (let k = parts.length; k >= 1; k--) {
    const hit = index.byClass.get(parts.slice(0, k).join('.'));
    if (hit) return hit === fromPath ? [] : [hit];
  }
  return [];
}

/** Maven pom.xml and Gradle build files: declared dependencies with the line that declares them. */
export function parseJavaDeps(read, allPaths) {
  const deps = [];
  const lineIdx = (txt, idx) => lineOf(txt, idx);
  for (const file of allPaths.filter((p) => /(^|\/)pom\.xml$/.test(p) && p.split('/').length <= 3)) {
    const txt = read(file);
    if (!txt) continue;
    for (const m of txt.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const tag = (t) => (new RegExp(`<${t}>\\s*([^<\\s]+)\\s*</${t}>`).exec(m[1]) || [])[1];
      const groupId = tag('groupId'), artifactId = tag('artifactId');
      if (!groupId || !artifactId || /\$\{/.test(groupId) || tag('scope') === 'test') continue;
      deps.push({ groupId, artifactId, version: tag('version') || null, file, line: lineIdx(txt, m.index) });
    }
  }
  for (const file of allPaths.filter((p) => /(^|\/)build\.gradle(\.kts)?$/.test(p) && p.split('/').length <= 3)) {
    const txt = read(file);
    if (!txt) continue;
    for (const m of txt.matchAll(/\b(implementation|api|compile|compileOnly|runtimeOnly)\s*\(?\s*['"]([^:'"\s]+):([^:'"\s]+)(?::([^'"\s]+))?['"]/g)) {
      deps.push({ groupId: m[2], artifactId: m[3], version: m[4] || null, file, line: lineIdx(txt, m.index) });
    }
  }
  // Name each dependency by groupId:artifactId, or by the groupId alone when several artifacts share a group
  // (an import names a package, which tells us the group but not which artifact supplied it).
  const perGroup = {};
  for (const d of deps) perGroup[d.groupId] = (perGroup[d.groupId] || 0) + 1;
  for (const d of deps) d.name = perGroup[d.groupId] > 1 ? d.groupId : `${d.groupId}:${d.artifactId}`;
  return deps;
}

/** The declared dependency whose groupId prefixes the imported name (longest match wins), or null. */
export function matchJavaDependency(spec, deps) {
  if (JDK.test(spec)) return null;
  let best = null;
  for (const d of deps) {
    if ((spec === d.groupId || spec.startsWith(d.groupId + '.')) && (!best || d.groupId.length > best.groupId.length)) best = d;
  }
  return best;
}

export const hasJavaMain = (text) => /public\s+static\s+void\s+main\s*\(/.test(text) || /@SpringBootApplication\b/.test(text);
