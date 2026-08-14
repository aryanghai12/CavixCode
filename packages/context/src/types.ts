// Ports + shapes for Stage 7 context assembly.

export interface FileReader {
  /** Return file content, or null if it does not exist. */
  read(path: string): Promise<string | null>;
}

export class MapFileReader implements FileReader {
  private readonly files: Map<string, string>;
  constructor(files: Record<string, string> | Map<string, string>) {
    this.files = files instanceof Map ? files : new Map(Object.entries(files));
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
}

export interface Discussion {
  path: string;
  pr: number;
  author: string;
  body: string;
}

export interface PastDiscussions {
  /** Prior PR discussion relevant to the touched files/modules. */
  forFiles(paths: string[]): Promise<Discussion[]>;
}

export class FakePastDiscussions implements PastDiscussions {
  private readonly byPath: Map<string, Discussion[]>;
  constructor(byPath: Record<string, Discussion[]> = {}) {
    this.byPath = new Map(Object.entries(byPath));
  }
  async forFiles(paths: string[]): Promise<Discussion[]> {
    const out: Discussion[] = [];
    for (const p of paths) out.push(...(this.byPath.get(p) ?? []));
    return out;
  }
}

// Compressor abstracts the CHEAP-model summarization of big files / verbose logs
// into tight briefs. Production wires it to the gateway with Haiku; the fake is
// deterministic for tests.
export interface Compressor {
  compress(text: string, instruction: string): Promise<string>;
}

/**
 * What a piece of context IS, which decides both its priority and what the model
 * is licensed to say on the strength of it.
 *
 * `rule` is the team's own law and outranks everything but the diff. `related`
 * is an embedding neighbour: useful for orientation, and never sufficient on its
 * own to support a posted finding, which is what the critic enforces.
 */
export type ContextKind = "rule" | "diff" | "caller" | "definition" | "discussion" | "related";

export interface ContextItem {
  kind: ContextKind;
  title: string;
  path?: string;
  line?: number;
  content: string;
  /** Higher = more important; packing keeps these first. */
  priority: number;
  tokens: number;
  compressed: boolean;
}

export interface ReviewContext {
  items: ContextItem[];
  /** Files that the change can affect (changed + callers). */
  blastFiles: string[];
  changedSymbols: string[];
  callerSymbols: string[];
  tokenEstimate: number;
  droppedForBudget: number;
  /**
   * The weakest evidence behind any call edge walked to build this.
   *
   * Carried all the way to the pull request, because a reach claim is only as
   * good as its shakiest link. "Resolved statically" is a stronger statement
   * than a heuristic parser can support the moment one edge was a name match,
   * and a review that says it anyway is inventing precision.
   */
  reachResolution?: "exact" | "heuristic" | "ambiguous";
  /**
   * Symbols too widely called to expand, with their real caller counts.
   *
   * Reported rather than hidden: a reviewer told `log()` has 412 callers reasons
   * differently from one shown 25 and left to assume that is all of them.
   */
  reachTruncated: Array<{ symbol: string; path: string; callers: number }>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
