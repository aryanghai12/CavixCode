import type { Language, RouteDef } from "./parser.ts";

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

/**
 * How much a call edge is actually worth.
 *
 * The distinction exists because the parsers are static and heuristic, and a
 * reach claim posted on somebody's pull request has to be able to say which of
 * these it stands on.
 *
 *   exact      only one thing it could be: the sole symbol with that name, or
 *              one reached through an import the file declares.
 *   heuristic  the right file or module, more than one candidate inside it.
 *   ambiguous  several candidates and no evidence choosing between them. Useful
 *              as CONTEXT for a model, never presentable to a human as a
 *              resolved call.
 */
export type EdgeResolution = "exact" | "heuristic" | "ambiguous";

/** Worst-first, so the weakest evidence for an edge is the one that survives. */
export const RESOLUTION_RANK: Record<EdgeResolution, number> = {
  ambiguous: 0,
  heuristic: 1,
  exact: 2,
};

/** A resolved call target, with the evidence behind it. */
export interface ResolvedTarget {
  id: string;
  resolution: EdgeResolution;
  /** How many symbols the name could have meant. Only set when more than one. */
  candidates?: number;
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
  /** HTTP entry points declared in this file. */
  routes: RouteDef[];
}

/** A route, and the symbol that declares it. */
export interface RouteRef {
  method: string;
  route: string;
  path: string;
  line: number;
  /** True when the declaring line mentions something auth-shaped. A hint. */
  guarded: boolean;
  /** The symbol enclosing the declaration, when there is one. */
  symbol?: string;
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
