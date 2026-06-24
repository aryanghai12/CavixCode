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

export interface ReviewResult {
  summary: string;
  findings: Finding[];
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
