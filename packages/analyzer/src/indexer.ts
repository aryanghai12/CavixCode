import { createHash } from "node:crypto";
import { parseUnifiedDiff } from "@cavix/core";
import { detectLanguage, type Parser } from "./parser.ts";
import {
  moduleBasename,
  symbolId,
  RESOLUTION_RANK,
  type EdgeResolution,
  type FileRecord,
  type ResolvedCall,
  type ResolvedTarget,
  type RouteRef,
  type SymbolNode,
} from "./graph.ts";

export interface SourceFile {
  path: string;
  content: string;
}

export interface BlastRadius {
  /** Symbols whose body overlaps the diff. */
  changed: SymbolNode[];
  /** Transitive callers of the changed symbols (excludes the changed set). */
  callers: SymbolNode[];
  /** Union of files involved (changed + caller files). */
  files: string[];
  /**
   * The WEAKEST evidence behind any edge that was traversed to build this.
   *
   * A reach claim is only as good as the shakiest link in it, so this is the
   * word a review is allowed to use: "resolved statically" when every edge was
   * exact, "resolved by name match" the moment one was not. Undefined when no
   * edges were traversed at all.
   */
  resolution?: EdgeResolution;
  /**
   * Symbols whose callers were NOT fully expanded because too many things call
   * them, with the real count.
   *
   * Reported rather than hidden. A reviewer told that `log()` has 412 callers
   * reasons differently from one shown 25 and left to assume that is all of
   * them, and quietly truncating is how the second happens.
   */
  truncated: Array<{ symbol: SymbolNode; callers: number }>;
}

export interface BlastRadiusOptions {
  /** How far to walk the caller graph. */
  depth?: number;
  /**
   * Stop expanding a symbol with more callers than this.
   *
   * A utility called from four hundred places contributes four hundred caller
   * snippets, which evicts every other kind of context under a fixed token
   * budget: the diff's own definitions, past discussions, the team's rules. The
   * cap is what stops one hot function crowding out everything a reviewer needs.
   */
  fanoutCap?: number;
}

/** Beyond this, a symbol is infrastructure and its caller list is noise. */
export const DEFAULT_FANOUT_CAP = 25;

// CodeIndex builds and maintains the whole-repo call graph. Parsing is
// incremental (only changed files are re-parsed); call-edge resolution is
// recomputed globally after a change because it is cheap relative to parsing and
// keeps cross-file edges correct when a symbol appears/disappears.
export class CodeIndex {
  private readonly parser: Parser;
  private readonly files = new Map<string, FileRecord>();
  private readonly symbols = new Map<string, SymbolNode>();
  private readonly byName = new Map<string, Set<string>>();
  private callsOut = new Map<string, Set<string>>();
  private callsIn = new Map<string, Set<string>>();
  /** "fromId toId" -> the evidence behind that edge. */
  private edgeResolution = new Map<string, EdgeResolution>();

  constructor(parser: Parser) {
    this.parser = parser;
  }

  /** Full index of a set of files. */
  indexFiles(files: SourceFile[]): void {
    for (const f of files) this.ingest(f.path, f.content);
    this.resolveEdges();
  }

  /** Incremental re-index of one changed/added file. Returns true if content changed. */
  updateFile(path: string, content: string): boolean {
    const existing = this.files.get(path);
    const h = hashContent(content);
    if (existing && existing.hash === h) return false; // unchanged → no work
    this.removeFileSymbols(path);
    this.ingest(path, content);
    this.resolveEdges();
    return true;
  }

  removeFile(path: string): void {
    this.removeFileSymbols(path);
    this.files.delete(path);
    this.resolveEdges();
  }

  // --- queries -------------------------------------------------------------

  /** All indexed file paths. */
  allFiles(): string[] {
    return [...this.files.keys()];
  }

  /**
   * Every symbol name the index resolved, deduplicated.
   *
   * Used to tell an invented identifier from a real one that happens not to
   * appear in the diff. The distinction matters: "the `validateRefund` helper"
   * is a hallucination when nothing by that name exists anywhere, and an
   * ordinary cross-file reference when it exists two directories away.
   */
  allSymbolNames(): string[] {
    return [...this.byName.keys()];
  }

  stats(): { files: number; symbols: number; edges: number } {
    let edges = 0;
    for (const s of this.callsOut.values()) edges += s.size;
    return { files: this.files.size, symbols: this.symbols.size, edges };
  }

  getSymbol(id: string): SymbolNode | undefined {
    return this.symbols.get(id);
  }

  /** All symbols defined with a given name (across files). */
  findByName(name: string): SymbolNode[] {
    const ids = this.byName.get(name);
    if (!ids) return [];
    return [...ids].map((id) => this.symbols.get(id)!).filter(Boolean);
  }

  symbolsInFile(path: string): SymbolNode[] {
    const rec = this.files.get(path);
    if (!rec) return [];
    return rec.symbolIds.map((id) => this.symbols.get(id)!).filter(Boolean);
  }

  /** Direct callers of a symbol. */
  callersOf(id: string): SymbolNode[] {
    const ids = this.callsIn.get(id);
    if (!ids) return [];
    return [...ids].map((c) => this.symbols.get(c)!).filter(Boolean);
  }

  /** Direct callees of a symbol. */
  calleesOf(id: string): SymbolNode[] {
    const ids = this.callsOut.get(id);
    if (!ids) return [];
    return [...ids].map((c) => this.symbols.get(c)!).filter(Boolean);
  }

  /**
   * Direct callees of a symbol IN THE ORDER THEY ARE WRITTEN, with the line each
   * call sits on.
   *
   * `calleesOf` cannot answer this and never could: `resolveEdges` folds every
   * call site into a `Set<string>`, which is the right shape for "what does this
   * reach" and throws away the two facts a sequence needs, order and position.
   * The ordered data was always there in `FileRecord.calls`; nothing had asked
   * for it.
   *
   * Repeated calls to the same target collapse to the first one. A loop that
   * calls `save()` three times is one interaction in a diagram, and drawing it
   * three times says something about the source that is not true of the flow.
   */
  callSitesFrom(id: string): Array<{ symbol: SymbolNode; line: number }> {
    const from = this.symbols.get(id);
    if (!from) return [];
    const rec = this.files.get(from.path);
    if (!rec) return [];

    const firstByTarget = new Map<string, number>();
    for (const call of rec.calls) {
      if (call.fromId !== id) continue;
      const target = this.resolveCallee(rec, call.callee);
      if (!target || target.id === id) continue;
      const seen = firstByTarget.get(target.id);
      if (seen === undefined || call.line < seen) firstByTarget.set(target.id, call.line);
    }

    return [...firstByTarget.entries()]
      .map(([targetId, line]) => ({ symbol: this.symbols.get(targetId)!, line }))
      .filter((e) => !!e.symbol)
      .sort((a, b) => a.line - b.line || a.symbol.name.localeCompare(b.symbol.name));
  }

  /** Transitive callees up to `depth` hops (what a symbol reaches, cross-file). */
  transitiveCallees(ids: string[], depth = 4): Set<string> {
    const seen = new Set<string>();
    let frontier = new Set(ids);
    for (let d = 0; d < depth && frontier.size > 0; d++) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const callee of this.callsOut.get(id) ?? []) {
          if (!seen.has(callee) && !ids.includes(callee)) {
            seen.add(callee);
            next.add(callee);
          }
        }
      }
      frontier = next;
    }
    return seen;
  }

  /** Transitive callers up to `depth` hops. */
  transitiveCallers(ids: string[], depth = 3): Set<string> {
    const seen = new Set<string>();
    let frontier = new Set(ids);
    for (let d = 0; d < depth && frontier.size > 0; d++) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const caller of this.callsIn.get(id) ?? []) {
          if (!seen.has(caller) && !ids.includes(caller)) {
            seen.add(caller);
            next.add(caller);
          }
        }
      }
      frontier = next;
    }
    return seen;
  }

  /** The symbol whose body encloses a given (path,line). */
  enclosingSymbol(path: string, line: number): SymbolNode | null {
    const rec = this.files.get(path);
    if (!rec) return null;
    let best: SymbolNode | null = null;
    for (const id of rec.symbolIds) {
      const s = this.symbols.get(id)!;
      if (s.line <= line && (!best || s.line > best.line)) best = s;
    }
    return best;
  }

  /** Project a unified diff onto the graph → changed symbols + their callers. */
  blastRadiusFromDiff(diff: string): BlastRadius {
    const files = parseUnifiedDiff(diff);
    const changedIds = new Set<string>();
    for (const f of files) {
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if ((l.kind === "add" || l.kind === "context") && l.newLineNo !== undefined) {
            const sym = this.enclosingSymbol(f.path, l.newLineNo);
            if (sym) changedIds.add(sym.id);
          }
        }
      }
    }
    return this.blastRadius([...changedIds]);
  }

  blastRadius(changedIds: string[], options: number | BlastRadiusOptions = {}): BlastRadius {
    // The old signature took a bare depth. Kept working, because several call
    // sites and tests pass one.
    const opts = typeof options === "number" ? { depth: options } : options;
    const depth = opts.depth ?? 3;
    const fanoutCap = opts.fanoutCap ?? DEFAULT_FANOUT_CAP;

    const changed = changedIds.map((id) => this.symbols.get(id)).filter((s): s is SymbolNode => !!s);

    const seen = new Set<string>();
    const truncated: BlastRadius["truncated"] = [];
    let weakest: EdgeResolution | undefined;
    const note = (r: EdgeResolution | undefined) => {
      if (!r) return;
      if (!weakest || RESOLUTION_RANK[r] < RESOLUTION_RANK[weakest]) weakest = r;
    };

    let frontier = new Set(changedIds);
    for (let d = 0; d < depth && frontier.size > 0; d++) {
      const next = new Set<string>();
      for (const id of frontier) {
        const callers = this.callsIn.get(id) ?? new Set<string>();
        if (callers.size > fanoutCap) {
          // Infrastructure. Expanding it would bury every other kind of context
          // under one hot function's caller list, so it is reported instead.
          const symbol = this.symbols.get(id);
          if (symbol) truncated.push({ symbol, callers: callers.size });
          continue;
        }
        for (const caller of callers) {
          note(this.edgeResolutionFor(caller, id));
          if (!seen.has(caller) && !changedIds.includes(caller)) {
            seen.add(caller);
            next.add(caller);
          }
        }
      }
      frontier = next;
    }

    const callers = [...seen].map((id) => this.symbols.get(id)!).filter(Boolean);
    const fileSet = new Set<string>();
    for (const s of changed) fileSet.add(s.path);
    for (const s of callers) fileSet.add(s.path);
    return {
      changed,
      callers,
      files: [...fileSet],
      ...(weakest ? { resolution: weakest } : {}),
      truncated,
    };
  }

  // --- internals -----------------------------------------------------------

  private ingest(path: string, content: string): void {
    const parsed = this.parser.parse(path, content);
    const symbolIds: string[] = [];
    // Sort defs by line so enclosing-symbol attribution is correct.
    const defs = [...parsed.symbols].sort((a, b) => a.line - b.line);
    // Two symbols in one file can share a name: `run` on two classes, an
    // overload, a method and a helper. `path#name` is the same string for both,
    // so the second overwrote the first in the symbol map and their CALLERS
    // MERGED. The blast radius for one then silently included the other's, which
    // is a wrong answer that looks exactly like a right one.
    //
    // The first occurrence keeps the plain id, so every id that exists today is
    // unchanged; later ones are disambiguated by their line.
    const usedIds = new Set<string>();
    for (const d of defs) {
      let id = symbolId(path, d.name);
      if (usedIds.has(id)) id = `${id}@${d.line}`;
      usedIds.add(id);
      const node: SymbolNode = { id, name: d.name, path, line: d.line, kind: d.kind, language: parsed.language };
      this.symbols.set(id, node);
      symbolIds.push(id);
      if (!this.byName.has(d.name)) this.byName.set(d.name, new Set());
      this.byName.get(d.name)!.add(id);
    }
    // Attribute each call to its enclosing symbol (nearest preceding def).
    const calls: ResolvedCall[] = parsed.calls.map((c) => ({
      fromId: enclosingIdAtLine(defs, path, c.line),
      callee: c.callee,
      line: c.line,
    }));
    const importedNames = new Set<string>();
    for (const imp of parsed.imports) for (const n of imp.names) importedNames.add(n);
    this.files.set(path, {
      path,
      hash: hashContent(content),
      language: detectLanguage(path),
      symbolIds,
      calls,
      importedModules: parsed.imports.map((i) => i.module),
      importedNames,
      routes: parsed.routes ?? [],
    });
  }

  private removeFileSymbols(path: string): void {
    const rec = this.files.get(path);
    if (!rec) return;
    for (const id of rec.symbolIds) {
      const node = this.symbols.get(id);
      if (node) {
        const set = this.byName.get(node.name);
        set?.delete(id);
        if (set && set.size === 0) this.byName.delete(node.name);
      }
      this.symbols.delete(id);
    }
  }

  // Rebuild all call edges from stored call sites. Cheap vs. parsing; keeps
  // cross-file resolution correct after any incremental change.
  private resolveEdges(): void {
    this.callsOut = new Map();
    this.callsIn = new Map();
    this.edgeResolution = new Map();
    for (const rec of this.files.values()) {
      for (const call of rec.calls) {
        if (!call.fromId) continue;
        const target = this.resolveCallee(rec, call.callee);
        if (!target || target.id === call.fromId) continue;
        if (!this.callsOut.has(call.fromId)) this.callsOut.set(call.fromId, new Set());
        this.callsOut.get(call.fromId)!.add(target.id);
        if (!this.callsIn.has(target.id)) this.callsIn.set(target.id, new Set());
        this.callsIn.get(target.id)!.add(call.fromId);
        // Keep the WEAKEST resolution seen for a pair. Two call sites can reach
        // the same symbol, one provably and one by guess, and an edge is only as
        // trustworthy as its worst evidence.
        const key = `${call.fromId} ${target.id}`;
        const seen = this.edgeResolution.get(key);
        if (!seen || RESOLUTION_RANK[target.resolution] < RESOLUTION_RANK[seen]) {
          this.edgeResolution.set(key, target.resolution);
        }
      }
    }
  }

  /** Every HTTP entry point the index knows about. */
  allRoutes(): RouteRef[] {
    const out: RouteRef[] = [];
    for (const rec of this.files.values()) {
      for (const r of rec.routes) {
        const symbol = this.enclosingSymbol(rec.path, r.line);
        out.push({
          method: r.method,
          route: r.route,
          path: rec.path,
          line: r.line,
          guarded: r.guarded,
          ...(symbol ? { symbol: symbol.id } : {}),
        });
      }
    }
    return out;
  }

  /**
   * Which HTTP entry points can reach these symbols.
   *
   * This is what turns a scanner's "string-built query" into a reviewer's "an
   * unauthenticated POST reaches a string-built query", and those two sentences
   * get very different responses from the person reading them.
   *
   * A route counts when the symbol declaring it is one of these symbols or one
   * of their transitive callers: the same walk the blast radius uses, so a route
   * reaches a change exactly when the code does. A route this parser could not
   * attribute to a symbol is left OUT rather than attached to a guess, because
   * the whole value of the sentence is that it is a measurement.
   */
  routesReaching(symbolIds: string[], depth = 4): RouteRef[] {
    const routes = this.allRoutes().filter((r) => r.symbol);
    if (routes.length === 0) return [];
    const reachable = new Set<string>(symbolIds);
    for (const id of this.transitiveCallers(symbolIds, depth)) reachable.add(id);
    return routes.filter((r) => reachable.has(r.symbol!));
  }

  /** How this caller edge was resolved, or undefined when there is no such edge. */
  edgeResolutionFor(fromId: string, toId: string): EdgeResolution | undefined {
    return this.edgeResolution.get(`${fromId} ${toId}`);
  }

  // Resolve a callee name to a target symbol, biasing toward (1) same file,
  // (2) a file this one imports (by basename or named import), (3) any match.
  /**
   * Which symbol does this call reach, and HOW SURE ARE WE.
   *
   * The second half used to be missing, and it mattered. The last line was
   * `return [...candidates][0]`: with three functions named `send` in the
   * repository and no import evidence, it picked whichever happened to be first
   * in a Set and recorded that as a call edge, indistinguishable from one it had
   * actually resolved. Downstream, a review could then name a "caller" that does
   * not call the changed code at all, and the Impact Scope would report the whole
   * thing as "resolved statically".
   *
   * The guess is still made, because a plausible caller is useful CONTEXT for a
   * model. What changed is that it is now labelled, so a claim posted on somebody's
   * pull request can be held to a higher bar than a hint fed to a prompt.
   */
  private resolveCallee(from: FileRecord, callee: string): ResolvedTarget | null {
    const candidates = this.byName.get(callee);
    if (!candidates || candidates.size === 0) return null;
    const ids = [...candidates];

    // Same file. Exact when there is only one of them; if the file declares the
    // name twice we know the file but not which one, so it is a guess about
    // which, not about where.
    const sameFile = ids.filter((id) => this.symbols.get(id)!.path === from.path);
    if (sameFile.length === 1) return { id: sameFile[0], resolution: "exact" };
    if (sameFile.length > 1) return { id: sameFile[0], resolution: "heuristic", candidates: sameFile.length };

    // Reached through an import this file actually declares.
    const importedBasenames = new Set(from.importedModules.map(moduleBasename));
    const viaImport = ids.filter((id) => {
      const base = moduleBasename(this.symbols.get(id)!.path);
      return importedBasenames.has(base) || from.importedNames.has(callee);
    });
    if (viaImport.length === 1) return { id: viaImport[0], resolution: "exact" };
    if (viaImport.length > 1) return { id: viaImport[0], resolution: "heuristic", candidates: viaImport.length };

    // Exactly one thing in the whole repository has this name. Nothing else it
    // could be, so this is a fact even without an import to prove it.
    if (ids.length === 1) return { id: ids[0], resolution: "exact" };

    // Several candidates and no evidence at all. Still returned, because a
    // plausible caller is worth showing a model, and never presented to a human
    // as a resolved call.
    return { id: ids[0], resolution: "ambiguous", candidates: ids.length };
  }
}

function enclosingIdAtLine(
  defs: { name: string; line: number }[],
  path: string,
  line: number,
): string | null {
  let best: { name: string; line: number } | null = null;
  for (const d of defs) {
    if (d.line <= line && (!best || d.line > best.line)) best = d;
  }
  return best ? symbolId(path, best.name) : null;
}

function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}
