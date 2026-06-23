import {
  detectLanguage,
  type CallSite,
  type ImportRef,
  type Language,
  type ParsedFile,
  type Parser,
  type SymbolDef,
} from "../parser.ts";

// HeuristicParser extracts definitions, call sites, and imports with line-based
// regexes. It is intentionally simple and language-tolerant: the goal is a useful
// call graph for blast radius and cross-file retrieval, not a compiler-grade AST.
// Anything it misses degrades retrieval gracefully (a missed edge = a missed
// caller), and a tree-sitter parser can replace it behind the Parser port.

// Tokens that look like calls but are control flow / keywords — never callees.
const NON_CALLEES = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "await",
  "typeof", "super", "constructor", "require", "import", "def", "func",
  "print", "len", "range", "new", "and", "or", "not", "in", "is",
]);

const CALL_RE = /(\b[A-Za-z_$][\w$]*)\s*\(/g;

export class HeuristicParser implements Parser {
  supports(language: Language): boolean {
    return language !== "unknown";
  }

  parse(path: string, source: string): ParsedFile {
    const language = detectLanguage(path);
    const lines = source.split("\n");
    const symbols: SymbolDef[] = [];
    const calls: CallSite[] = [];
    const imports: ImportRef[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;
      this.collectDefs(language, line, lineNo, symbols);
      this.collectImports(language, line, lineNo, imports);
      this.collectCalls(line, lineNo, calls);
    }
    return { path, language, symbols, calls, imports };
  }

  private collectDefs(lang: Language, line: string, lineNo: number, out: SymbolDef[]): void {
    const push = (name: string, kind: string) => {
      if (name && !NON_CALLEES.has(name)) out.push({ name, line: lineNo, kind });
    };
    if (lang === "javascript" || lang === "typescript") {
      let m = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m) push(m[1], "function");
      m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/.exec(line);
      if (m) push(m[1], "function");
      m = /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m) push(m[1], "class");
      // class method: "name(args) {" not preceded by a keyword
      m = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{?\s*$/.exec(line);
      if (m && !/\b(function|if|for|while|switch|catch|return)\b/.test(line)) push(m[1], "method");
    } else if (lang === "python") {
      const m = /^\s*def\s+([A-Za-z_]\w*)/.exec(line);
      if (m) push(m[1], "function");
      const c = /^\s*class\s+([A-Za-z_]\w*)/.exec(line);
      if (c) push(c[1], "class");
    } else if (lang === "go") {
      // func Name( ... )  OR  func (recv T) Name( ... )
      let m = /^\s*func\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      if (m) push(m[1], "function");
      m = /^\s*func\s*\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/.exec(line);
      if (m) push(m[1], "method");
    }
  }

  private collectImports(lang: Language, line: string, lineNo: number, out: ImportRef[]): void {
    if (lang === "javascript" || lang === "typescript") {
      let m = /^\s*import\s+(?:\{([^}]*)\}\s+from\s+)?["']([^"']+)["']/.exec(line);
      if (m) {
        const names = m[1] ? m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean) : [];
        out.push({ module: m[2], names, line: lineNo });
        return;
      }
      m = /\brequire\(\s*["']([^"']+)["']\s*\)/.exec(line);
      if (m) out.push({ module: m[1], names: [], line: lineNo });
    } else if (lang === "python") {
      let m = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
      if (m) {
        const names = m[2].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        out.push({ module: m[1], names, line: lineNo });
        return;
      }
      m = /^\s*import\s+([\w.]+)/.exec(line);
      if (m) out.push({ module: m[1], names: [], line: lineNo });
    } else if (lang === "go") {
      const m = /^\s*(?:import\s+)?"([^"]+)"\s*$/.exec(line);
      if (m && line.includes('"')) out.push({ module: m[1], names: [], line: lineNo });
    }
  }

  private collectCalls(line: string, lineNo: number, out: CallSite[]): void {
    // We scan every line, including definition lines: a def line like
    // `function refresh(t){ return validateToken(t); }` carries a real call
    // (validateToken) plus the def name itself (refresh). The def-name match
    // becomes a self-edge, which the indexer filters, so nothing is lost and
    // same-line calls are captured.
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(line)) !== null) {
      const callee = m[1];
      if (!NON_CALLEES.has(callee)) out.push({ callee, line: lineNo });
    }
  }
}
