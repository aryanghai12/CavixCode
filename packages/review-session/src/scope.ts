import { parseUnifiedDiff } from "@cavix/core";
import type { LedgerEntry, PrLedger } from "./ledger.ts";

// Narrowing what a RE-review reads, without narrowing what it is responsible for.
//
// Every review of a pull request reads the whole thing, `base...head`. On the
// tenth push of a forty-file pull request that means paying to re-read
// thirty-nine files nobody has touched since the last review, and it gets worse
// as the pull request gets longer, which is exactly backwards: the later pushes
// are usually the small ones.
//
// The obvious fix is to review only the newest commit. That is wrong, and it is
// wrong in the direction that loses defects: the merge introduces the whole
// diff, not the last commit, and a reviewer that only ever sees the last commit
// can never report anything about the rest of it.
//
// So two domains, and keeping them apart is the whole idea:
//
//   VERDICT domain   base...head. Never narrowed. What the merge would introduce
//                    and what the check run gates on.
//   ATTENTION domain what this push actually changed, plus anything still open.
//                    What the model is paid to read again.
//
// Narrowing attention is only SOUND because the ledger exists. A finding raised
// three pushes ago is still open, still counted, and still holds the merge,
// whether or not this review re-read its file. Without that memory, narrowing
// would silently drop findings; with it, a file nobody touched needs no second
// opinion, because the first one is still on the record.

/** What a re-review should read again, and what it can safely skip. */
export interface ReviewScope {
  /**
   * Files this push changed. Full attention: context, tools, the ensemble.
   */
  hot: string[];
  /**
   * Files this push did NOT change but which carry an open finding.
   *
   * Not re-read, and not forgotten either. The ledger decides what happens to
   * their findings, exactly as it does today: unchanged code cannot have been
   * fixed, so those findings carry.
   */
  warm: string[];
  /**
   * In the pull request, untouched by this push, and carrying nothing open.
   *
   * Counted and reported, never re-read. Saying so out loud is what makes the
   * narrowing honest rather than a silent gap in coverage.
   */
  cold: string[];
  /**
   * Was attention actually narrowed?
   *
   * False on a first review, and false whenever something made narrowing unsafe.
   * The caller uses this to decide whether to pass the delta diff or the whole
   * one, so a false here means "behave exactly as you always did".
   */
  narrowed: boolean;
  /** Why the whole pull request is being re-read, when it is. */
  reason: string;
}

export interface ScopeInput {
  /** The whole pull request: base...head. Always the verdict domain. */
  verdictDiff: string;
  /**
   * Just this push: the previous review's head to this one.
   *
   * Empty or absent means there is nothing to narrow to, which is the first
   * review of a pull request.
   */
  deltaDiff?: string;
  /** What earlier reviews left open. */
  ledger: PrLedger;
  /** The head the ledger was last written against. */
  priorHeadSha?: string;
  headSha: string;
  /**
   * Reasons the caller already knows narrowing is unsafe.
   *
   * The caller knows things this module cannot see: that the branch was rebased,
   * that a human asked for a fresh review, that the repository's own rules
   * changed. Any one of them means the previous reviews were formed against
   * different premises and cannot be relied on.
   */
  forceFull?: string;
}

/**
 * Decide what this review has to read again.
 *
 * Pure. Given the same inputs it makes the same decision, which matters because
 * a reviewer that silently reads less on some runs than others is impossible to
 * reason about when it misses something.
 */
export function scopeFor(input: ScopeInput): ReviewScope {
  const allFiles = pathsIn(input.verdictDiff);
  const full = (reason: string): ReviewScope => ({
    hot: allFiles,
    warm: [],
    cold: [],
    narrowed: false,
    reason,
  });

  if (input.forceFull) return full(input.forceFull);
  // No previous review, or no idea which commit it read. Nothing to narrow
  // against, and guessing would mean skipping files on no evidence at all.
  if (!input.priorHeadSha || input.priorHeadSha === input.headSha) {
    return full("this is the first review of this pull request");
  }
  const delta = (input.deltaDiff ?? "").trim();
  if (delta === "") return full("nothing recorded what this push changed");

  const changed = new Set(pathsIn(delta));
  // A push that touches a file the pull request as a whole does not is a sign
  // the two diffs were computed against different things. Re-read everything
  // rather than trusting a comparison that does not line up.
  const unknown = [...changed].filter((p) => !allFiles.includes(p));
  if (unknown.length > 0) {
    return full("this push and the pull request diff disagree about which files changed");
  }

  const openPaths = new Set(
    input.ledger.entries.filter((e) => e.state === "open").map((e) => e.path),
  );

  const hot: string[] = [];
  const warm: string[] = [];
  const cold: string[] = [];
  for (const path of allFiles) {
    if (changed.has(path)) hot.push(path);
    else if (openPaths.has(path)) warm.push(path);
    else cold.push(path);
  }

  // Nothing was actually saved. Reporting a narrowing that narrowed nothing
  // would put a "not re-read" row on a review that read everything.
  if (cold.length === 0 && warm.length === 0) {
    return full("this push touched every file in the pull request");
  }

  return {
    hot,
    warm,
    cold,
    narrowed: true,
    reason: `${hot.length} of ${allFiles.length} files changed since the last review`,
  };
}

/**
 * Open findings in files this review did not re-read.
 *
 * They are carried by the ledger on the ordinary path, because their files did
 * not change. This exists so a caller can state the number, rather than leaving
 * a reader to wonder what happened to a finding whose file is not mentioned.
 */
export function openInSkippedFiles(ledger: PrLedger, scope: ReviewScope): LedgerEntry[] {
  if (!scope.narrowed) return [];
  const skipped = new Set([...scope.warm, ...scope.cold]);
  return ledger.entries.filter((e) => e.state === "open" && skipped.has(e.path));
}

function pathsIn(diff: string): string[] {
  const out: string[] = [];
  for (const f of parseUnifiedDiff(diff)) {
    if (f.path && !out.includes(f.path)) out.push(f.path);
  }
  return out;
}
