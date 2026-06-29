// Legacy/enterprise language parsing so reviews are LOCATED (path + line +
// symbol). Heuristic and tolerant — enough to anchor findings and give the agents
// structure on COBOL, PL/SQL, C/C++, older Java/.NET, and IaC/SQL/config.

export type LegacyLanguage =
  | "cobol"
  | "plsql"
  | "cpp"
  | "java"
  | "csharp"
  | "terraform"
  | "yaml"
  | "sql"
  | "unknown";

export interface LegacySymbol {
  name: string;
  line: number;
  kind: string;
  language: LegacyLanguage;
}

const EXT: Record<string, LegacyLanguage> = {
  cob: "cobol", cbl: "cobol", cpy: "cobol",
  pls: "plsql", pkb: "plsql", pks: "plsql", plsql: "plsql",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp",
  java: "java", cs: "csharp", tf: "terraform", yaml: "yaml", yml: "yaml", sql: "sql",
};

export function detectLegacyLanguage(path: string): LegacyLanguage {
  return EXT[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "unknown";
}

export function parseLegacy(path: string, content: string): LegacySymbol[] {
  const lang = detectLegacyLanguage(path);
  const lines = content.split("\n");
  switch (lang) {
    case "cobol": return cobol(lines, lang);
    case "plsql":
    case "sql": return plsql(lines, lang);
    case "cpp": return cpp(lines, lang);
    case "java":
    case "csharp": return jvmLike(lines, lang);
    default: return [];
  }
}

function cobol(lines: string[], lang: LegacyLanguage): LegacySymbol[] {
  const out: LegacySymbol[] = [];
  let inProc = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = raw.length > 6 ? raw.slice(6) : raw; // skip sequence-number area
    if (/PROCEDURE\s+DIVISION/i.test(code)) inProc = true;
    const sec = /^\s*([A-Z0-9][A-Z0-9-]*)\s+SECTION\s*\./i.exec(code);
    if (sec) { out.push({ name: sec[1], line: i + 1, kind: "section", language: lang }); continue; }
    if (inProc) {
      const para = /^\s{0,4}([A-Z0-9][A-Z0-9-]*)\s*\.\s*$/.exec(code);
      if (para && !/^(EXIT|STOP|GOBACK|END)/i.test(para[1])) out.push({ name: para[1], line: i + 1, kind: "paragraph", language: lang });
    }
  }
  return out;
}

function plsql(lines: string[], lang: LegacyLanguage): LegacySymbol[] {
  const out: LegacySymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /\b(PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER)\s+([A-Za-z_]\w*)/i.exec(lines[i]);
    if (m) out.push({ name: m[2], line: i + 1, kind: m[1].toLowerCase().replace(/\s+/g, "-"), language: lang });
  }
  return out;
}

function cpp(lines: string[], lang: LegacyLanguage): LegacySymbol[] {
  const out: LegacySymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const def = /^[A-Za-z_][\w:<>,\s\*&]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const)?\s*\{?\s*$/.exec(lines[i]);
    if (def && !/\b(if|for|while|switch|return|sizeof)\b/.test(lines[i])) out.push({ name: def[1], line: i + 1, kind: "function", language: lang });
    const macro = /^\s*#define\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (macro) out.push({ name: macro[1], line: i + 1, kind: "macro", language: lang });
  }
  return out;
}

function jvmLike(lines: string[], lang: LegacyLanguage): LegacySymbol[] {
  const out: LegacySymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /\b(?:public|private|protected|internal|static|final|virtual|override|\s)+[\w<>\[\],.]+\s+([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/.exec(lines[i]);
    if (m && !/\b(if|for|while|switch|catch)\b/.test(lines[i])) out.push({ name: m[1], line: i + 1, kind: "method", language: lang });
    const cls = /\b(?:class|interface)\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (cls) out.push({ name: cls[1], line: i + 1, kind: "class", language: lang });
  }
  return out;
}
