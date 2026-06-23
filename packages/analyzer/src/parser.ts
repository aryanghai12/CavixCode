// The Parser port: turn a source file into symbols (definitions), call sites, and
// imports. Phase 1 ships heuristic regex parsers (fast, dependency-free, hermetic)
// behind this interface; a tree-sitter / stack-graphs parser can replace them per
// language without touching the graph, indexer, or retrieval code above.

export type Language = "javascript" | "typescript" | "python" | "go" | "unknown";

export interface SymbolDef {
  /** Symbol name, e.g. "validateToken". */
  name: string;
  /** 1-based line of the definition. */
  line: number;
  /** "function" | "method" | "class". */
  kind: string;
}

export interface CallSite {
  /** Called name, e.g. "validateToken". */
  callee: string;
  line: number;
}

export interface ImportRef {
  /** Module specifier, e.g. "./auth" or "os". */
  module: string;
  /** Named imports, when statically visible (e.g. import { a, b }). */
  names: string[];
  line: number;
}

export interface ParsedFile {
  path: string;
  language: Language;
  symbols: SymbolDef[];
  calls: CallSite[];
  imports: ImportRef[];
}

export interface Parser {
  supports(language: Language): boolean;
  parse(path: string, source: string): ParsedFile;
}

const EXT_LANG: Record<string, Language> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".go": "go",
};

export function detectLanguage(path: string): Language {
  const i = path.lastIndexOf(".");
  if (i === -1) return "unknown";
  return EXT_LANG[path.slice(i).toLowerCase()] ?? "unknown";
}
