import { parseUnifiedDiff } from "@cavix/core";
import type { CodeIndex, SymbolNode, Embedder } from "@cavix/analyzer";
import { cosine } from "@cavix/analyzer";
import {
  estimateTokens,
  type Compressor,
  type ContextItem,
  type Discussion,
  type FileReader,
  type PastDiscussions,
  type ReviewContext,
} from "./types.ts";

export interface AssembleInput {
  org: string;
  diff: string;
}

export interface ContextAssemblerOptions {
  index: CodeIndex;
  files: FileReader;
  discussions?: PastDiscussions;
  compressor?: Compressor;
  embedder?: Embedder;
  /** Token budget for the whole context block. */
  budgetTokens?: number;
  /** Compress any single item whose content exceeds this many chars. */
  compressOverChars?: number;
  /** How many lines around a symbol definition to include. */
  snippetLines?: number;
}

// ContextAssembler turns a diff into a budgeted, structured context using the
// code graph for RECALL (callers across files), embeddings for SEMANTIC neighbors,
// past discussions for institutional memory, and a cheap model to compress.
export class ContextAssembler {
  private readonly opts: Required<Omit<ContextAssemblerOptions, "discussions" | "compressor" | "embedder">> &
    Pick<ContextAssemblerOptions, "discussions" | "compressor" | "embedder">;

  constructor(options: ContextAssemblerOptions) {
    this.opts = {
      index: options.index,
      files: options.files,
      discussions: options.discussions,
      compressor: options.compressor,
      embedder: options.embedder,
      budgetTokens: options.budgetTokens ?? 6000,
      compressOverChars: options.compressOverChars ?? 1200,
      snippetLines: options.snippetLines ?? 24,
    };
  }

  async assemble(input: AssembleInput): Promise<ReviewContext> {
    const { index } = this.opts;
    const blast = index.blastRadiusFromDiff(input.diff);
    const changedSymbols = blast.changed.map((s) => s.id);
    const callerSymbols = blast.callers.map((s) => s.id);

    const items: ContextItem[] = [];

    // 1. The diff itself — always the top priority.
    items.push(this.item("diff", "Change under review (diff)", input.diff, 100));

    // 2. Cross-file callers — the recall win: code the diff can break, in OTHER
    //    files, that a diff-only reviewer never sees.
    for (const caller of blast.callers) {
      const snippet = await this.snippetFor(caller);
      if (snippet) {
        items.push(this.item("caller", `Caller of changed code: ${caller.name} (${caller.path})`, snippet, 80, caller.path, caller.line));
      }
    }

    // 3. Definitions of the changed symbols (full context of what changed).
    for (const changed of blast.changed) {
      const snippet = await this.snippetFor(changed);
      if (snippet) {
        items.push(this.item("definition", `Definition: ${changed.name} (${changed.path})`, snippet, 70, changed.path, changed.line));
      }
    }

    // 4. Past PR discussions on the touched files — institutional memory.
    if (this.opts.discussions) {
      const ds = await this.opts.discussions.forFiles(blast.files);
      for (const d of ds) items.push(this.discussionItem(d));
    }

    // 5. Semantic neighbors via embeddings (optional, lower priority).
    if (this.opts.embedder) {
      items.push(...(await this.semanticNeighbors(input.diff, blast.files)));
    }

    // Compress oversized items with the cheap model, then pack within budget.
    await this.compressOversized(items);
    return this.pack(items, blast, changedSymbols, callerSymbols);
  }

  private async snippetFor(sym: SymbolNode): Promise<string | null> {
    const content = await this.opts.files.read(sym.path);
    if (content === null) return null;
    const lines = content.split("\n");
    const start = Math.max(0, sym.line - 1);
    const end = Math.min(lines.length, start + this.opts.snippetLines);
    return lines.slice(start, end).join("\n");
  }

  // Embedding-based retrieval: rank files NOT already in the graph blast set by
  // cosine similarity to the diff, and surface the top few. This catches related
  // code the call graph misses (e.g. a sibling module with the same concept but
  // no direct call edge) — complementary recall to the graph.
  private async semanticNeighbors(diff: string, exclude: string[]): Promise<ContextItem[]> {
    const embedder = this.opts.embedder!;
    const excludeSet = new Set([...exclude, ...parseUnifiedDiff(diff).map((f) => f.path)]);
    const diffVec = await embedder.embed(diff);

    const scored: Array<{ path: string; score: number; content: string }> = [];
    for (const path of this.opts.index.allFiles()) {
      if (excludeSet.has(path)) continue;
      const content = await this.opts.files.read(path);
      if (!content) continue;
      const score = cosine(diffVec, await embedder.embed(content));
      scored.push({ path, score, content });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, 2)
      .filter((s) => s.score > 0.1)
      .map((s) => this.item("related", `Semantically related: ${s.path} (sim ${s.score.toFixed(2)})`, s.content, 40, s.path));
  }

  private discussionItem(d: Discussion): ContextItem {
    const content = `PR #${d.pr} (${d.author}) on ${d.path}:\n${d.body}`;
    return this.item("discussion", `Past discussion on ${d.path}`, content, 50, d.path);
  }

  private item(kind: ContextItem["kind"], title: string, content: string, priority: number, path?: string, line?: number): ContextItem {
    return { kind, title, content, priority, path, line, tokens: estimateTokens(content), compressed: false };
  }

  private async compressOversized(items: ContextItem[]): Promise<void> {
    if (!this.opts.compressor) return;
    for (const it of items) {
      if (it.kind === "diff") continue; // never compress the actual change
      if (it.content.length <= this.opts.compressOverChars) continue;
      const brief = await this.opts.compressor.compress(it.content, `Summarize this ${it.kind} for a code reviewer; keep signatures, control flow, and anything safety-relevant.`);
      it.content = brief;
      it.tokens = estimateTokens(brief);
      it.compressed = true;
    }
  }

  private pack(items: ContextItem[], blast: { files: string[]; changed: SymbolNode[]; callers: SymbolNode[] }, changedSymbols: string[], callerSymbols: string[]): ReviewContext {
    const ordered = [...items].sort((a, b) => b.priority - a.priority);
    const kept: ContextItem[] = [];
    let used = 0;
    let dropped = 0;
    for (const it of ordered) {
      if (used + it.tokens <= this.opts.budgetTokens || kept.length === 0) {
        kept.push(it);
        used += it.tokens;
      } else {
        dropped++;
      }
    }
    return {
      items: kept,
      blastFiles: blast.files,
      changedSymbols,
      callerSymbols,
      tokenEstimate: used,
      droppedForBudget: dropped,
    };
  }
}

// Render the assembled context into a single prompt block for the agents.
export function renderContextPrompt(ctx: ReviewContext): string {
  const parts: string[] = [];
  for (const it of ctx.items) {
    const tag = it.compressed ? " (compressed)" : "";
    const loc = it.path ? ` [${it.path}${it.line ? ":" + it.line : ""}]` : "";
    parts.push(`### ${it.title}${loc}${tag}\n${fence(it)}`);
  }
  return parts.join("\n\n");
}

function fence(it: ContextItem): string {
  if (it.kind === "diff") return "```diff\n" + it.content.trimEnd() + "\n```";
  if (it.kind === "discussion") return it.content;
  return "```\n" + it.content.trimEnd() + "\n```";
}
