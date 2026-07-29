// A line-level Myers diff, and the reason this package exists at all.
//
// Every platform Cavix supports hands over a unified diff except Azure DevOps,
// whose `diffs/commits` API returns a list of CHANGED PATHS and no content. So
// on Azure the diff has to be computed here, from the two versions of each file.
//
// WHY THAT IS NOT A DETAIL
//
// Everything downstream treats the diff as exact. `commentableLines` decides
// which lines an inline comment may anchor to, and every platform rejects an
// anchor that is not in the diff. A finding's line number is the line a human is
// sent to. The sandbox reproduces a bug at a coordinate that came from here. An
// APPROXIMATE diff does not fail: it silently moves findings onto the wrong
// lines, and nothing downstream can tell that it happened.
//
// So this is Myers' algorithm as published ("An O(ND) Difference Algorithm and
// its Variations", Myers 1986), which is exact and minimal, and NOT a heuristic
// that is right most of the time. The one concession to running inside a review
// is a bound: past `maxEdits` this REFUSES rather than falling back to something
// cheaper. A refusal is visible on the pull request; a wrong diff is not.

/** One line of the edit script. */
export interface EditOp {
  kind: "equal" | "insert" | "delete";
  line: string;
}

export interface DiffLimits {
  /**
   * Ceiling on the edit distance.
   *
   * Myers costs O((N+M)·D) in time and, because the backtrack needs one frontier
   * per D, O(D^2) integers in memory. This bound is what makes both finite. It
   * is set where it is because real code changes have a tiny D even in large
   * files: an edit distance over a thousand lines in ONE file means the file was
   * rewritten, and a rewrite is not a diff anybody reads line by line.
   */
  maxEdits?: number;
  /** Ceiling on lines per side. A generated or vendored file is not a review. */
  maxLines?: number;
}

export const DEFAULT_LIMITS: Required<DiffLimits> = {
  maxEdits: 1500,
  maxLines: 20_000,
};

/** Why a file could not be diffed exactly. Reported to the reader, never swallowed. */
export type DiffRefusal =
  | { reason: "too-many-lines"; lines: number; limit: number }
  | { reason: "too-many-edits"; limit: number }
  | { reason: "binary" };

export type DiffOutcome = { ok: true; ops: EditOp[] } | { ok: false; refusal: DiffRefusal };

/**
 * The minimal edit script turning `a` into `b`, or a refusal.
 *
 * Myers' greedy forward pass records the furthest-reaching path on each diagonal
 * for each edit distance D; backtracking through those frontiers recovers the
 * script. Only diagonals -D..D are live at step D, so each frontier is stored at
 * exactly that width rather than at the worst case, which is the difference
 * between a few kilobytes on a normal file and megabytes on every file.
 */
export function diffLines(a: string[], b: string[], limits: DiffLimits = {}): DiffOutcome {
  const maxEdits = limits.maxEdits ?? DEFAULT_LIMITS.maxEdits;
  const maxLines = limits.maxLines ?? DEFAULT_LIMITS.maxLines;

  if (a.length > maxLines || b.length > maxLines) {
    return {
      ok: false,
      refusal: { reason: "too-many-lines", lines: Math.max(a.length, b.length), limit: maxLines },
    };
  }

  const n = a.length;
  const m = b.length;

  // A side that is empty has no search to do, and this is the common shape for
  // an added or a deleted file. The general path below would give the same
  // answer; this one gives it without allocating a frontier.
  if (n === 0 && m === 0) return { ok: true, ops: [] };
  if (n === 0) return { ok: true, ops: b.map((line): EditOp => ({ kind: "insert", line })) };
  if (m === 0) return { ok: true, ops: a.map((line): EditOp => ({ kind: "delete", line })) };

  const max = Math.min(n + m, maxEdits);
  // The live frontier, indexed by diagonal k through this offset.
  //
  // One wider than `max` on each side, because the backtrack reads the diagonal
  // NEXT to the one it is on, and at d = 0 that is k = 1: the seed. Sizing the
  // array to exactly -max..max made trace[0] a single cell, the read fell off
  // the end, and every hunk silently lost its leading context along with the
  // `@@` start line that is computed from it.
  const offset = max + 1;
  const v = new Int32Array(2 * (max + 1) + 1);
  /**
   * Frontier snapshots. `trace[d]` covers diagonals -(d+1)..(d+1), so a read of
   * k+1 or k-1 is always in range, and diagonal k sits at index `k + d + 1`.
   */
  const trace: Int32Array[] = [];

  // V[1] = 0 seeds the search so D=0, k=0 starts at x=0. (Myers, figure 2.)
  v[offset + 1] = 0;

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const i = offset + k;
      // Extend the furthest-reaching path from a neighbouring diagonal: down
      // (an insertion, from k+1) or right (a deletion, from k-1).
      const down = k === -d || (k !== d && v[i - 1] < v[i + 1]);
      let x = down ? v[i + 1] : v[i - 1] + 1;
      let y = x - k;
      // The "snake": identical lines are consumed for free.
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[i] = x;
      if (x >= n && y >= m) return { ok: true, ops: backtrack(a, b, trace, n, m) };
    }
  }

  // Past the bound. Refuse, loudly. The alternative is a plausible-looking diff
  // that puts findings on lines they do not belong to.
  return { ok: false, refusal: { reason: "too-many-edits", limit: maxEdits } };
}

/**
 * Walk the recorded frontiers backwards to recover the script.
 *
 * At each D the same rule that chose a neighbouring diagonal going forwards says
 * which one the path came from, so the single non-snake step is an insertion
 * when x did not move and a deletion when it did. The snake before it is emitted
 * as equal lines.
 */
function backtrack(a: string[], b: string[], trace: Int32Array[], n: number, m: number): EditOp[] {
  const out: EditOp[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const frontier = trace[d];
    /** `trace[d]` covers -(d+1)..(d+1), so diagonal k sits at index k + d + 1. */
    const at = (k: number): number => frontier[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      out.push({ kind: "equal", line: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        out.push({ kind: "insert", line: b[y - 1] });
        y--;
      } else {
        out.push({ kind: "delete", line: a[x - 1] });
        x--;
      }
    }
  }

  out.reverse();
  return out;
}

/**
 * Split a file into the lines a diff has to see.
 *
 * A trailing newline TERMINATES the last line rather than starting an empty one,
 * which is the difference between "3 lines" and "3 lines and a phantom fourth",
 * and therefore between a right and a wrong line number for every finding below
 * it. CRLF is normalised on both sides so a checkout setting does not read as
 * every line in the file having changed.
 */
export function splitLines(content: string): string[] {
  const normalised = content.replace(/\r\n/g, "\n");
  if (normalised === "") return [];
  const lines = normalised.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Does this content look like something a line diff has no business splitting?
 *
 * A NUL byte is the same test `git` uses, and it is the right one: it is a
 * property of the bytes rather than of the file name, so a `.png` full of text
 * is diffed and a `.txt` full of binary is not.
 */
export function looksBinary(content: string): boolean {
  // Bounded: a NUL in the first few kilobytes is decisive, and scanning a
  // multi-megabyte string to find one at the end costs more than it settles.
  return content.slice(0, 8192).includes("\u0000");
}
