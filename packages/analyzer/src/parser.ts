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

/**
 * An HTTP entry point declared in this file.
 *
 * The one edge kind that changes what a review can SAY rather than how much it
 * can see. A scanner reports "string-built query"; a reviewer that knows the
 * routes reports "an unauthenticated POST reaches a string-built query", and
 * those two sentences get very different responses from the person reading them.
 *
 * Deliberately shallow: the declaration line and what it says. Whether the
 * handler is really reachable is a graph question, answered by the index.
 */
export interface RouteDef {
  /** Upper-case verb, or "ANY" for a framework that does not say. */
  method: string;
  /** The path as written, e.g. "/api/refunds/:id". */
  route: string;
  line: number;
  /**
   * True when the declaration line also mentions something auth-shaped.
   *
   * A hint, never a verdict. Middleware applied elsewhere is invisible to a line
   * parser, so this can only ever say "this line mentions auth" and never "this
   * route is protected". Anything that claims the second from the first is
   * guessing about security, which is the worst place to guess.
   */
  guarded: boolean;
}

export interface ParsedFile {
  path: string;
  language: Language;
  symbols: SymbolDef[];
  calls: CallSite[];
  imports: ImportRef[];
  /** HTTP entry points, when the file declares any. */
  routes?: RouteDef[];
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
