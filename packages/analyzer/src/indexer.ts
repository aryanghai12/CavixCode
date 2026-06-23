import { createHash } from "node:crypto";
import { parseUnifiedDiff } from "@cavix/core";
import { detectLanguage, type Parser } from "./parser.ts";
import {
  moduleBasename,
  symbolId,
  type FileRecord,
  type ResolvedCall,
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
}

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

  blastRadius(changedIds: string[], depth = 3): BlastRadius {
    const changed = changedIds.map((id) => this.symbols.get(id)).filter((s): s is SymbolNode => !!s);
    const callerIds = this.transitiveCallers(changedIds, depth);
    const callers = [...callerIds].map((id) => this.symbols.get(id)!).filter(Boolean);
    const fileSet = new Set<string>();
    for (const s of changed) fileSet.add(s.path);
    for (const s of callers) fileSet.add(s.path);
    return { changed, callers, files: [...fileSet] };
  }

  // --- internals -----------------------------------------------------------

  private ingest(path: string, content: string): void {
    const parsed = this.parser.parse(path, content);
    const symbolIds: string[] = [];
    // Sort defs by line so enclosing-symbol attribution is correct.
    const defs = [...parsed.symbols].sort((a, b) => a.line - b.line);
    for (const d of defs) {
      const id = symbolId(path, d.name);
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
    for (const rec of this.files.values()) {
      for (const call of rec.calls) {
        if (!call.fromId) continue;
        const targetId = this.resolveCallee(rec, call.callee);
        if (!targetId || targetId === call.fromId) continue;
        if (!this.callsOut.has(call.fromId)) this.callsOut.set(call.fromId, new Set());
        this.callsOut.get(call.fromId)!.add(targetId);
        if (!this.callsIn.has(targetId)) this.callsIn.set(targetId, new Set());
        this.callsIn.get(targetId)!.add(call.fromId);
      }
    }
  }

  // Resolve a callee name to a target symbol, biasing toward (1) same file,
  // (2) a file this one imports (by basename or named import), (3) any match.
  private resolveCallee(from: FileRecord, callee: string): string | null {
    const candidates = this.byName.get(callee);
    if (!candidates || candidates.size === 0) return null;

    const sameFile = [...candidates].find((id) => this.symbols.get(id)!.path === from.path);
    if (sameFile) return sameFile;

    const importedBasenames = new Set(from.importedModules.map(moduleBasename));
    const viaImport = [...candidates].find((id) => {
      const p = this.symbols.get(id)!.path;
      const base = moduleBasename(p);
      return importedBasenames.has(base) || from.importedNames.has(callee);
    });
    if (viaImport) return viaImport;

    return [...candidates][0];
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
