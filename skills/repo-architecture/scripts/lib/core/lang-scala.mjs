// Scala support for the scanner: Scala shares the JVM package model with Java and Kotlin, so it shares their
// class index (lang-java.mjs: buildJavaIndex, resolveJavaImport) rather than building its own. This file only
// adds what is different — import syntax, package-chain declarations, top-level symbols, sbt dependencies and
// entry-point detection. Pure (no Node APIs).
const lineOf = (text, idx) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

const J = (spec, line, names, wildcard) => ({ spec, line, names, java: { isStatic: false, wildcard } });

// import a.b.C; import a.b.{C, D}; import a.b.{C => E}; import a.b._ (Scala 2); import a.b.* (Scala 3).
// A single `import` with several comma-separated fully-qualified paths and no braces (`import a.B, c.D`) is
// not parsed — rare in practice, and a missed edge is safe (dropped, not guessed), unlike a wrong one.
export function scalaImports(text) {
  const out = [];
  const re = /^[ \t]*import\s+([^\n;]+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const line = m[1].trim();
    const at = lineOf(text, m.index);
    const braced = /^([\w.]+)\.\{([^}]*)\}$/.exec(line);
    if (braced) {
      const base = braced[1];
      for (const part of braced[2].split(',').map((s) => s.trim()).filter(Boolean)) {
        if (part === '_' || part === '*') { out.push(J(`${base}.*`, at, [], true)); continue; }
        const renamed = /^(\w+)\s*=>\s*(\w+|_)$/.exec(part);
        if (renamed) { out.push(J(`${base}.${renamed[1]}`, at, renamed[2] === '_' ? [] : [renamed[2]], false)); continue; }
        if (/^\w+$/.test(part)) out.push(J(`${base}.${part}`, at, [], false));
      }
      continue;
    }
    const wildcard = /^([\w.]+)\.(?:_|\*)$/.exec(line);
    if (wildcard) { out.push(J(`${wildcard[1]}.*`, at, [], true)); continue; }
    if (/^[\w.]+$/.test(line)) out.push(J(line, at, [], false));
  }
  return out;
}

/** `package a.b` and the stacked form (`package a` then `package b` means a.b for what follows), file-level only.
    Block comments are stripped first — a real file almost always opens with a license header. */
export function scalaPackage(text) {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const parts = [];
  for (const raw of stripped.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;
    const m = /^package\s+([\w.]+)\s*$/.exec(line);
    if (!m) break;
    parts.push(m[1]);
  }
  return parts.join('.');
}

const DECL_RE = /^(?:(?:private|protected|sealed|final|abstract|implicit|case)\s+)*(?:class|object|trait)\s+(\w+)/gm;

export function scalaSymbols(text) {
  const out = [];
  let m;
  DECL_RE.lastIndex = 0;
  while ((m = DECL_RE.exec(text)) && out.length < 12) if (!out.some((s) => s.name === m[1])) out.push({ name: m[1], line: lineOf(text, m.index) });
  return out;
}

export const hasScalaMain = (text) =>
  /\bobject\s+\w+\s+extends\s+(?:App\b|.*\bApp\b)/.test(text) || /\bdef\s+main\s*\(\s*args\s*:\s*Array\s*\[\s*String\s*\]\s*\)/.test(text);

/** `"group" %% "artifact" % "version"` (or `%` for a Java dependency) inside build.sbt. */
export function parseSbtDeps(read, allPaths) {
  const deps = [];
  for (const file of allPaths.filter((p) => /(^|\/)build\.sbt$/.test(p) && p.split('/').length <= 3)) {
    const txt = read(file);
    if (!txt) continue;
    const re = /"([^"]+)"\s*%%?\s*"([^"]+)"\s*%\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(txt))) deps.push({ groupId: m[1], artifactId: m[2], version: m[3], file, line: lineOf(txt, m.index), name: `${m[1]}:${m[2]}` });
  }
  return deps;
}
