import { diffLines, looksBinary, splitLines, type DiffLimits, type DiffRefusal, type EditOp } from "./myers.ts";

// Turning an edit script into the unified diff the rest of Cavix parses.
//
// The output has to be byte-comparable with what `git diff` would have produced,
// because `parseUnifiedDiff` in @cavix/core is the only reader and it was
// written against git. In particular the `@@ -a,b +c,d @@` numbers have to be
// right: they are where every finding's line number ultimately comes from.

/** One file's two versions. `null` means the file does not exist on that side. */
export interface FileVersions {
  /** Path in the new tree. For a deletion, the path it had. */
  path: string;
  /** Path in the old tree, when it differs (a rename). */
  oldPath?: string;
  before: string | null;
  after: string | null;
}

/** A file that could not be diffed exactly, and why, in a reader's words. */
export interface UnrenderedFile {
  path: string;
  /** One sentence, printed verbatim on the pull request. */
  reason: string;
}

export interface UnifiedDiffResult {
  /** The unified diff, ready for `parseUnifiedDiff`. */
  diff: string;
  /**
   * Files deliberately left out, with why.
   *
   * NEVER empty because something was dropped quietly. A file that could not be
   * diffed is a file Cavix did not review, and a review that does not say which
   * files it skipped is claiming coverage it does not have.
   */
  unrendered: UnrenderedFile[];
}

export interface UnifiedDiffOptions extends DiffLimits {
  /** Lines of context around each hunk. Three is what git uses and what readers expect. */
  contextLines?: number;
}

const DEFAULT_CONTEXT = 3;

/**
 * Build a unified diff for a set of files.
 *
 * Files are emitted in the order given, so the caller controls it; a file whose
 * two sides are identical produces nothing at all (Azure lists a path as changed
 * when only its mode or its properties moved).
 */
export function buildUnifiedDiff(files: FileVersions[], options: UnifiedDiffOptions = {}): UnifiedDiffResult {
  const context = options.contextLines ?? DEFAULT_CONTEXT;
  const out: string[] = [];
  const unrendered: UnrenderedFile[] = [];

  for (const file of files) {
    const before = file.before;
    const after = file.after;

    if (before === null && after === null) {
      unrendered.push({ path: file.path, reason: "neither version of this file could be read" });
      continue;
    }
    if ((before !== null && looksBinary(before)) || (after !== null && looksBinary(after))) {
      unrendered.push({ path: file.path, reason: "binary file, not reviewable line by line" });
      continue;
    }

    const a = before === null ? [] : splitLines(before);
    const b = after === null ? [] : splitLines(after);
    const outcome = diffLines(a, b, options);
    if (!outcome.ok) {
      unrendered.push({ path: file.path, reason: refusalSentence(outcome.refusal) });
      continue;
    }
    if (!outcome.ops.some((op) => op.kind !== "equal")) continue; // nothing actually changed

    const hunks = toHunks(outcome.ops, context);
    if (hunks.length === 0) continue;

    const oldPath = after === null ? file.path : (file.oldPath ?? file.path);
    out.push(`diff --git a/${oldPath} b/${file.path}`);
    out.push(`--- ${before === null ? "/dev/null" : `a/${oldPath}`}`);
    out.push(`+++ ${after === null ? "/dev/null" : `b/${file.path}`}`);
    for (const h of hunks) out.push(...h);
  }

  return { diff: out.length > 0 ? `${out.join("\n")}\n` : "", unrendered };
}

function refusalSentence(r: DiffRefusal): string {
  switch (r.reason) {
    case "too-many-lines":
      return `${r.lines} lines, over the ${r.limit} Cavix diffs in one file`;
    case "too-many-edits":
      return `rewritten past the ${r.limit}-line edit budget, so no exact diff could be produced`;
    case "binary":
      return "binary file, not reviewable line by line";
  }
}

/**
 * Group the edit script into hunks with `context` unchanged lines around each
 * run of changes, merging runs that are close enough that their context would
 * overlap. This is exactly git's grouping, and it matters: a reader comparing
 * Cavix's diff to the one on the pull request page must see the same hunks.
 */
function toHunks(ops: EditOp[], context: number): string[][] {
  // Index of every op that is a change, so runs can be found without scanning.
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].kind !== "equal") changed.push(i);
  if (changed.length === 0) return [];

  // Merge runs whose context windows touch. Two changes separated by 2*context
  // or fewer equal lines belong in one hunk, because splitting them would print
  // the same lines twice.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const i of changed) {
    const last = ranges[ranges.length - 1];
    if (last && i - last.end <= context * 2 + 1) last.end = i;
    else ranges.push({ start: i, end: i });
  }

  // Line numbers advance as we walk the script: an equal line advances both
  // sides, an insert only the new side, a delete only the old side.
  const oldNo: number[] = new Array(ops.length);
  const newNo: number[] = new Array(ops.length);
  let o = 1;
  let n = 1;
  for (let i = 0; i < ops.length; i++) {
    oldNo[i] = o;
    newNo[i] = n;
    if (ops[i].kind !== "insert") o++;
    if (ops[i].kind !== "delete") n++;
  }

  const hunks: string[][] = [];
  for (const range of ranges) {
    const from = Math.max(0, range.start - context);
    const to = Math.min(ops.length - 1, range.end + context);

    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let i = from; i <= to; i++) {
      const op = ops[i];
      if (op.kind === "equal") {
        body.push(` ${op.line}`);
        oldCount++;
        newCount++;
      } else if (op.kind === "delete") {
        body.push(`-${op.line}`);
        oldCount++;
      } else {
        body.push(`+${op.line}`);
        newCount++;
      }
    }

    // git writes a zero-length side as `-0,0`, not `-1,0`: a hunk that adds to
    // an empty file starts at line 0 on the old side. Getting this wrong shifts
    // every line number in a newly added file by one.
    const oldStart = oldCount === 0 ? 0 : oldNo[from];
    const newStart = newCount === 0 ? 0 : newNo[from];
    hunks.push([`@@ -${span(oldStart, oldCount)} +${span(newStart, newCount)} @@`, ...body]);
  }
  return hunks;
}

/** git omits the count when it is exactly 1: "@@ -5 +5,2 @@". */
function span(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}
