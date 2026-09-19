// Kotlin package and import parsing. Resolution is shared with the Java resolver
// so Kotlin and Java sources in the same project can refer to one another.
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

export function kotlinImports(text) {
  const out = [];
  const re = /^[ \t]*import\s+([\w.]+(?:\.\*)?)(?:\s+as\s+(`[^`]+`|\w+))?\s*;?[ \t]*(?:\/\/.*)?$/gm;
  let m;
  while ((m = re.exec(text))) {
    const alias = m[2]?.replaceAll('`', '') || null;
    const wildcard = m[1].endsWith('.*');
    out.push({
      spec: m[1], line: lineOf(text, m.index), names: alias ? [alias] : [],
      java: { isStatic: false, wildcard },
    });
  }
  return out;
}

export function kotlinPackage(text) {
  const m = /^\s*package\s+([\w.]+)\s*;?/m.exec(text);
  return m ? m[1] : '';
}

export function kotlinSymbols(text) {
  const out = [];
  const re = /^\s*(?:(?:public|protected|private|internal|open|abstract|data|sealed|enum|annotation|value|expect|actual|inner|const|external|inline|suspend|tailrec|operator|infix)\s+)*(?:class|interface|object|typealias)\s+(`[^`]+`|\w+)/gm;
  let m;
  while ((m = re.exec(text)) && out.length < 12) {
    const name = m[1].replaceAll('`', '');
    if (!out.some((s) => s.name === name)) out.push({ name, line: lineOf(text, m.index) });
  }
  return out;
}

export const hasKotlinMain = (text) => /^\s*(?:(?:public|internal|suspend)\s+)*fun\s+main\s*\(/m.test(text);
