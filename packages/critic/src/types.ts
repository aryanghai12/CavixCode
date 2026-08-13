import type { Finding } from "@cavix/core";

// The critic is not a second reviewer. It never reads the code looking for bugs.
// It reads a DRAFT FINDING plus the material the reviewer was actually shown and
// answers one question: does that material support this claim?
//
// Everything in this package is DETERMINISTIC. No model is called, nothing is
// sampled, and the same finding against the same corpus always gets the same
// verdict. That is deliberate, and it is why this stage was built before the
// model-driven critic rather than after it: the three hallucination classes that
// do the most damage to a reviewer's credibility are all decidable by a program.
//
//   1. Phantom location   a finding at refund.ts:412 in a file with 300 lines
//   2. Phantom symbol     "the validateRefund helper", which does not exist
//   3. Phantom file       a finding in a file this pull request never touched
//
// A reviewer that cites a line which does not exist is not merely wrong. It is
// visibly not reading, and a reader who catches one stops believing the other
// forty. No amount of model agreement fixes that, because models from one family
// reading one context agree on the same hallucination.

/**
 * What the critic concluded about one finding.
 *
 * `REPAIRABLE` is not `UNSUPPORTED`. It means the claim may well be true but the
 * corpus does not carry it, which is a reason to ask again with more context or
 * to lower confidence, not a reason to delete somebody's bug report.
 */
export type Verdict = "SUPPORTED" | "REPAIRABLE" | "UNSUPPORTED";

/** The individual decisions behind a verdict, each one a computed fact. */
export interface CriticChecks {
  /** Does the finding's file appear in the change under review? */
  fileInDiff: boolean;
  /** Is the line within the file, as far as anything measurable can tell? */
  lineInRange: boolean;
  /** Did every code identifier the finding names appear somewhere real? */
  symbolsResolve: boolean;
  /** Does the finding cite anything at all? */
  hasEvidence: boolean;
}

export interface CriticReport {
  /** Index of the finding in the array handed to `screen`. */
  index: number;
  verdict: Verdict;
  checks: CriticChecks;
  /**
   * The specific defect in the claim, in a sentence a human can act on.
   * Empty for SUPPORTED. Never a generic "low confidence".
   */
  objection: string;
  /**
   * Multiplier applied to the finding's confidence, in (0, 1].
   * 1 means untouched. UNSUPPORTED findings do not get one: they are dropped.
   */
  confidenceFactor: number;
  /** Identifiers the finding named that resolved against nothing. */
  unresolvedSymbols: string[];
}

/**
 * Everything the reviewer was shown, which is the only thing its claims may
 * stand on.
 *
 * Every field except the diff is optional, and each absent field DISABLES the
 * check that depends on it rather than guessing. A critic that flags a symbol as
 * phantom because nobody handed it the index would delete true findings, which
 * is far worse than the hallucination it was trying to catch.
 */
export interface CriticCorpus {
  /** The change under review, as a unified diff. */
  diff: string;
  /**
   * Total line count per file in the HEAD tree, where known.
   *
   * Enables the phantom-line check. Without it a line number beyond the end of a
   * file is unfalsifiable, because a finding may legitimately point at a line
   * that is in the file but not in the diff.
   */
  fileLines?: ReadonlyMap<string, number>;
  /** Every symbol name the AST index resolved for this change, if it ran. */
  knownSymbols?: Iterable<string>;
  /**
   * The assembled context block the reviewer actually read.
   *
   * Widens symbol resolution to anything quoted in a caller snippet or a
   * definition, which is where most legitimate cross-file references come from.
   */
  contextText?: string;
}

export interface CriticOptions {
  /**
   * Treat an unresolved symbol as UNSUPPORTED rather than REPAIRABLE.
   *
   * Off by default and it should stay off unless the corpus is known to be
   * complete. On a partial corpus this deletes true findings.
   */
  strictSymbols?: boolean;
  /** Confidence multiplier for a REPAIRABLE finding. */
  repairableFactor?: number;
}

export type Screened = { finding: Finding; report: CriticReport };
