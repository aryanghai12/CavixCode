import type { Language } from "./parser.ts";

// The code graph: symbols (nodes) connected by resolved call edges, plus the
// per-file records the incremental indexer maintains. In production this is
// persisted to Postgres (symbols/edges tables) with embeddings in pgvector; the
// in-memory shape here mirrors that schema 1:1 so the persistence swap is
// mechanical (see ARCHITECTURE "Stage 4 persistence").

export interface SymbolNode {
  /** Stable id: `${path}#${name}`. */
  id: string;
  name: string;
  path: string;
  line: number;
  kind: string;
  language: Language;
}

/** A call site already attributed to its enclosing symbol (or null = top-level). */
export interface ResolvedCall {
  fromId: string | null;
  callee: string;
  line: number;
}

export interface FileRecord {
  path: string;
  hash: string;
  language: Language;
  symbolIds: string[];
  calls: ResolvedCall[];
  importedModules: string[];
  /** Import names statically visible, used to bias call resolution. */
  importedNames: Set<string>;
}

export function symbolId(path: string, name: string): string {
  return `${path}#${name}`;
}

/** Basename without extension, for import↔file matching ("./auth" ↔ "src/auth.ts"). */
export function moduleBasename(spec: string): string {
  const noExt = spec.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py|go)$/i, "");
  const parts = noExt.split(/[\/\\.]/).filter(Boolean);
  return parts[parts.length - 1] ?? noExt;
}
