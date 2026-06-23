import type { Finding } from "@cavix/core";
import type { CodeIndex } from "@cavix/analyzer";
import {
  type OrgPolicyConfig,
  type PolicyFile,
  type PolicyRule,
} from "./types.ts";
import { endpointNeedsAuth } from "./rules/endpointAuth.ts";
import { bannedImport } from "./rules/bannedImport.ts";

// Built-in example rules. Orgs can register their own; these ship as references.
export const DEFAULT_RULES: PolicyRule[] = [endpointNeedsAuth, bannedImport];

export interface PolicyEvalInput {
  files: PolicyFile[];
  index?: CodeIndex;
}

// PolicyEngine evaluates the org gate. The single most important behavior:
//   - gate OFF (default) → returns [] unconditionally. Nothing is force-passed.
//   - gate ON → returns deterministic findings tagged source="policy",
//     immutable=true, confidence=1. These never touch an LLM and the adjudicator
//     is contractually forbidden from dropping immutable findings, so they are
//     structurally non-bypassable.
export class PolicyEngine {
  private readonly rules: Map<string, PolicyRule>;

  constructor(rules: PolicyRule[] = DEFAULT_RULES) {
    this.rules = new Map(rules.map((r) => [r.id, r]));
  }

  evaluate(input: PolicyEvalInput, config: OrgPolicyConfig): Finding[] {
    // The gate ships off. An org must explicitly enable it.
    if (!config.enabled) return [];

    const findings: Finding[] = [];
    for (const [id, rc] of Object.entries(config.rules)) {
      if (!rc.enabled) continue;
      const rule = this.rules.get(id);
      if (!rule) continue;
      const violations = rule.evaluate({
        files: input.files,
        index: input.index,
        options: rc.options ?? {},
      });
      for (const v of violations) {
        findings.push({
          path: v.path,
          line: v.line,
          severity: rule.severity,
          category: rule.category,
          title: rule.title,
          body: v.message,
          source: "policy",
          ruleId: `policy/${rule.id}`,
          confidence: 1,
          immutable: true, // the structural basis of non-bypassability
        });
      }
    }
    return findings;
  }
}
