import { parseUnifiedDiff, type DiffFile, type Finding } from "@cavix/core";
import type { CriticChecks, CriticCorpus, CriticOptions, CriticReport, Screened, Verdict } from "./types.ts";

const DEFAULT_REPAIRABLE_FACTOR = 0.6;

/**
 * Words that appear in backticks constantly and are not symbols anybody could
 * resolve. Flagging these would make every finding look like a hallucination.
 */
const NOT_SYMBOLS = new Set([
  // language and runtime vocabulary
  "null", "undefined", "true", "false", "nan", "void", "this", "self", "super",
  "async", "await", "return", "throw", "catch", "try", "finally", "const", "let",
  "var", "function", "class", "interface", "type", "enum", "struct", "import",
  "export", "default", "new", "delete", "typeof", "instanceof", "yield", "static",
  // types everybody names
  "string", "number", "boolean", "object", "array", "map", "set", "promise",
  "error", "any", "unknown", "never", "int", "float", "bool", "byte", "char",
  "list", "dict", "tuple", "none", "nil", "err", "ok",
  // prose that lands in backticks
  "get", "post", "put", "patch", "head", "options", "http", "https", "json",
  "yaml", "toml", "env", "sql", "api", "url", "uri", "uuid", "id", "ids",
  "true_", "todo", "fixme", "note",
]);

/**
 * Pull the code identifiers out of a finding's prose.
 *
 * ONLY bare identifiers in backticks. A backticked expression (`foo.bar()`, a
 * path, a snippet with spaces) is not something this can resolve, and guessing
 * at it produces false accusations. Two characters or fewer is noise.
 */
export function identifiersIn(text: string): string[] {
  const out = new Set<string>();
  const backticked = text.match(/`([^`\n]+)`/g) ?? [];
  for (const raw of backticked) {
    const inner = raw.slice(1, -1).trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(inner)) continue;
    if (inner.length < 3) continue;
    if (NOT_SYMBOLS.has(inner.toLowerCase())) continue;
    // A word with no case boundary and no underscore is probably English, not
    // an identifier: "the `token` is missing" should not be a symbol claim.
    const looksLikeCode = /[a-z][A-Z]/.test(inner) || inner.includes("_") || /^[A-Z]/.test(inner) || inner.includes("$");
    if (!looksLikeCode) continue;
    out.add(inner);
  }
  return [...out];
}

/** Every add/context line of the diff, as one searchable blob per file and overall. */
function diffText(files: DiffFile[]): string {
  const parts: string[] = [];
  for (const f of files) {
    parts.push(f.path);
    for (const h of f.hunks) {
      parts.push(h.header);
      for (const l of h.lines) parts.push(l.content);
    }
  }
  return parts.join("\n");
}

/**
 * The largest new-file line number the diff proves exists in a file.
 *
 * A lower bound, never an upper one: a file certainly has at least this many
 * lines, and may have far more outside the diff. Used only to widen the range a
 * finding is allowed to point at.
 */
function maxKnownLine(f: DiffFile): number {
  let max = 0;
  for (const h of f.hunks) max = Math.max(max, h.newStart + h.newLines);
  return max;
}

/**
 * Screen a batch of draft findings against what the reviewer was actually shown.
 *
 * Pure and synchronous. Every verdict here is a computed fact, so it can run on
 * every finding of every review at no cost and with no variance.
 */
export function screen(
  findings: readonly Finding[],
  corpus: CriticCorpus,
  options: CriticOptions = {},
): CriticReport[] {
  const repairableFactor = options.repairableFactor ?? DEFAULT_REPAIRABLE_FACTOR;
  const files = parseUnifiedDiff(corpus.diff);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const haystack = `${diffText(files)}\n${corpus.contextText ?? ""}`;
  const known = new Set<string>(corpus.knownSymbols ?? []);

  return findings.map((f, index) => {
    const file = byPath.get(f.path);
    const checks: CriticChecks = {
      fileInDiff: file !== undefined,
      lineInRange: true,
      symbolsResolve: true,
      hasEvidence: (f.evidence?.length ?? 0) > 0,
    };
    const objections: string[] = [];
    let verdict: Verdict = "SUPPORTED";
    let factor = 1;

    // 1. Phantom file. The strongest signal there is: a review comment about a
    //    file this pull request does not touch cannot be anchored, cannot be
    //    acted on, and is usually the model reasoning about a file it imagined.
    if (!checks.fileInDiff) {
      verdict = "UNSUPPORTED";
      objections.push(`\`${f.path}\` is not part of this change`);
    }

    // 2. Phantom line. Only decidable where the file's real length is known;
    //    a finding may legitimately point at a line outside the diff.
    const total = corpus.fileLines?.get(f.path);
    const ceiling = total ?? (file ? Math.max(maxKnownLine(file), 0) : 0);
    if (f.line <= 0) {
      checks.lineInRange = false;
      verdict = "UNSUPPORTED";
      objections.push(`line ${f.line} is not a line number`);
    } else if (total !== undefined && f.line > total) {
      checks.lineInRange = false;
      verdict = "UNSUPPORTED";
      objections.push(`line ${f.line} is past the end of \`${f.path}\`, which has ${total} lines`);
    } else if (total === undefined && file && ceiling > 0 && f.line > ceiling * LINE_SLACK) {
      // The file's true length is unknown, so this is a suspicion rather than a
      // fact: the line is far beyond anything the diff shows. It lowers
      // confidence and never deletes the finding on its own.
      checks.lineInRange = false;
      if (verdict === "SUPPORTED") verdict = "REPAIRABLE";
      objections.push(`line ${f.line} is well beyond anything the diff shows for \`${f.path}\``);
    }

    // 3. Phantom symbol. Resolved against the diff, the assembled context, and
    //    the AST index together, because a legitimate cross-file reference comes
    //    from one of those three and nowhere else.
    const named = identifiersIn(`${f.title}\n${f.body}`);
    const unresolved = named.filter((s) => !known.has(s) && !containsWord(haystack, s));
    if (unresolved.length > 0) {
      checks.symbolsResolve = false;
      const list = unresolved.map((s) => `\`${s}\``).join(", ");
      objections.push(`${list} ${unresolved.length === 1 ? "appears" : "appear"} nowhere in the code this review read`);
      if (options.strictSymbols) {
        verdict = "UNSUPPORTED";
      } else if (verdict === "SUPPORTED") {
        verdict = "REPAIRABLE";
      }
    }

    if (verdict === "REPAIRABLE") factor = repairableFactor;

    return {
      index,
      verdict,
      checks,
      objection: objections.join("; "),
      confidenceFactor: factor,
      unresolvedSymbols: unresolved,
    };
  });
}

/**
 * How far past the deepest line in the diff a finding may point before the
 * critic gets suspicious, when the file's real length is unknown.
 *
 * Generous on purpose. A finding legitimately anchored outside the diff is
 * common; one anchored at four times the deepest changed line is not.
 */
const LINE_SLACK = 4;

/** Whole-identifier match, so `refund` does not resolve against `refundTotal`. */
function containsWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(haystack);
}

/**
 * Apply a screening to a batch: what survives, what does not, and what was
 * merely downgraded.
 *
 * Deterministic findings and immutable policy findings pass through UNTOUCHED,
 * whatever the critic said. A linter does not hallucinate; if a tool reports a
 * line the critic cannot place, the tool is right and the corpus is incomplete.
 * Dropping it would be the critic overruling a fact with an inference.
 */
export function applyScreen(
  findings: readonly Finding[],
  reports: readonly CriticReport[],
): { kept: Finding[]; dropped: Array<{ finding: Finding; reason: string }>; screened: Screened[] } {
  const kept: Finding[] = [];
  const dropped: Array<{ finding: Finding; reason: string }> = [];
  const screened: Screened[] = [];

  findings.forEach((f, i) => {
    const report = reports[i];
    if (!report) {
      kept.push(f);
      return;
    }
    screened.push({ finding: f, report });

    const exempt = f.source !== "llm" || f.immutable === true;
    if (report.verdict === "UNSUPPORTED" && !exempt) {
      dropped.push({ finding: f, reason: `critic: ${report.objection}` });
      return;
    }
    if (report.confidenceFactor < 1 && !exempt) {
      kept.push({ ...f, confidence: round2(f.confidence * report.confidenceFactor) });
      return;
    }
    kept.push(f);
  });

  return { kept, dropped, screened };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
