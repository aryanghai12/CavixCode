// The Finding is Cavix's atomic output: one reviewable issue at one location.
// Phase 0 produces only LLM findings, but the shape already carries the fields
// later stages need — `source` (so deterministic linter/secret/policy findings
// can be marked immune from LLM drop), `confidence` (for Stage 9 adjudication),
// and `suggestion` (for Stage 11 one-click verified fixes).

export type Severity = "critical" | "high" | "medium" | "low" | "info";

// Where a finding came from. Deterministic sources (linter/secret/sast/telemetry/
// policy) are the ones the LLM is not allowed to silently drop downstream.
export type FindingSource = "llm" | "linter" | "secret" | "sast" | "telemetry" | "policy";

// A piece of cited evidence backing a finding — used by Stage 8 agents to ground
// a claim (e.g. "the contract is defined at auth.ts:12") and shown to reviewers.
export interface Evidence {
  path: string;
  line?: number;
  snippet?: string;
  note?: string;
}

/**
 * One executed step of a verification run: what ran and how it exited. This is
 * the receipt a reader checks.
 *
 * Deliberately no captured stdout/stderr. The full output lives in the
 * verifier's own StepLog for debugging; carrying it here would push kilobytes of
 * build noise into every finding, through every consumer, to render a line that
 * says "exit 1" either way.
 */
export interface VerificationStep {
  /** "install" | "repro" | "after-fix" | "suite". */
  step: string;
  cmd: string;
  code: number;
  timedOut?: boolean;
}

/**
 * The outcome of Stage 10 for one finding. It lives on the Finding (not in the
 * verifier package) because everything downstream — the poster, the dashboard,
 * the fix-PR agent — needs to read the proof without depending on how it was
 * produced. `status` is the whole product claim: VERIFIED means Cavix ran the
 * code and watched the bug happen.
 */
export interface Verification {
  status: "VERIFIED" | "UNVERIFIED" | "INCONCLUSIVE";
  /** True when the proof is a PoC exploit rather than a failing test. */
  exploit: boolean;
  reproduced: boolean;
  /** Did applying the suggested fix resolve the reproduction? */
  fixWorks?: boolean;
  /** Did the repo's existing suite still pass with the fix applied? */
  suitePasses?: boolean;
  /** One human sentence: why this status. */
  reason: string;
  testPath?: string;
  steps: VerificationStep[];
}

export interface Finding {
  /** File path relative to repo root, matching the diff's new-file path. */
  path: string;
  /** 1-based line number in the new version of the file. */
  line: number;
  /** Optional end line for multi-line findings. */
  endLine?: number;
  severity: Severity;
  /** Free-form bucket, e.g. "security" | "correctness" | "performance". */
  category: string;
  /** One-line headline shown in the PR comment. */
  title: string;
  /** Markdown explanation of the issue and why it matters. */
  body: string;
  /** Optional suggested replacement code (drives Stage 11 one-click fixes). */
  suggestion?: string;
  source: FindingSource;
  /** Stable rule id for deterministic/policy findings; absent for free LLM ones. */
  ruleId?: string;
  /** Model/heuristic confidence in [0,1]; feeds Stage 9 thresholding. */
  confidence: number;
  /** Which Stage 8 agent (or tool) produced it, for adjudication voting. */
  agent?: string;
  /** Cited evidence — often cross-file — that grounds the finding. */
  evidence?: Evidence[];
  /**
   * Stage 10 proof. Present only when the finding went through the sandbox;
   * absent means "not verified", which is NOT the same as "disproven" (a
   * disproven finding is suppressed and never reaches a Finding a reader sees).
   */
  verification?: Verification;
  /**
   * When true, this finding is exempt from adjudication drop/dedupe-merge and
   * always survives to posting. Set ONLY by the enabled org policy gate
   * (source=policy). This is the structural basis of a non-bypassable gate.
   */
  immutable?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * One row of the walkthrough: what changed in a single file, in plain English.
 * This is what turns the PR comment from "here are 3 problems" into a review a
 * non-author can follow — the reader sees what each file does before they read
 * any finding about it.
 */
export interface FileChange {
  path: string;
  summary: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  /** Per-file walkthrough, one entry per changed file. Absent if the model omits it. */
  walkthrough?: FileChange[];
  /** How much human attention this PR deserves, 1 (trivial) to 5 (demanding). */
  effort?: number;
  usage: Usage;
  costUsd: number;
  model: string;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};
