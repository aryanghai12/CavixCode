import type { Severity } from "@cavix/core";
import type { CodeIndex } from "@cavix/analyzer";

// Stage 3c — the OPTIONAL org policy gate. This is NOT a security product and is
// NOT OWASP-hardcoded: it is a generic, org-owned set of plain rules ("every
// endpoint needs an auth check", "don't import the banned module") that most orgs
// will leave OFF. When an org turns it on, its findings are deterministic,
// source="policy", and immutable — they bypass the LLM entirely and survive
// adjudication unchanged. That is what makes the gate structurally non-bypassable.

export interface PolicyFile {
  path: string;
  content: string;
}

export interface PolicyContext {
  files: PolicyFile[];
  /** Optional code graph for cross-file checks (e.g. named handlers). */
  index?: CodeIndex;
  /** Per-rule options from the org config. */
  options: Record<string, unknown>;
}

export interface PolicyViolation {
  path: string;
  line: number;
  message: string;
}

export interface PolicyRule {
  id: string;
  title: string;
  severity: Severity;
  /** Generic category (NOT necessarily security) — e.g. "governance". */
  category: string;
  evaluate(ctx: PolicyContext): PolicyViolation[];
}

export interface RuleConfig {
  enabled: boolean;
  options?: Record<string, unknown>;
}

// The org's policy configuration. `enabled` defaults to false everywhere it is
// constructed — the gate ships OFF.
export interface OrgPolicyConfig {
  enabled: boolean;
  rules: Record<string, RuleConfig>;
}

/** A disabled gate — the default for every org until they opt in. */
export const POLICY_OFF: OrgPolicyConfig = { enabled: false, rules: {} };
