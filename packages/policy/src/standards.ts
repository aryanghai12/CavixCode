import type { PolicyRule, OrgPolicyConfig, RuleConfig } from "./types.ts";
import { PolicyEngine, DEFAULT_RULES } from "./engine.ts";
import { compileEnglishRule } from "./compile.ts";

// Ingest a repo's STANDARDS.md (or an admin's rule list) — plain-English bullet
// rules — and compile each into a deterministic PolicyRule. Lines that don't
// compile are returned as errors (surfaced to the admin), never silently ignored.

export interface CompiledStandards {
  rules: PolicyRule[];
  config: OrgPolicyConfig;
  errors: Array<{ text: string; error: string }>;
}

export function parseStandardsLines(md: string): string[] {
  return md
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export function compileStandards(md: string, opts: { enabled?: boolean } = {}): CompiledStandards {
  const rules: PolicyRule[] = [];
  const errors: CompiledStandards["errors"] = [];
  const ruleConfig: Record<string, RuleConfig> = {};
  for (const line of parseStandardsLines(md)) {
    const r = compileEnglishRule(line);
    if (r.ok) {
      rules.push(r.rule);
      ruleConfig[r.rule.id] = { enabled: true };
    } else {
      errors.push({ text: line, error: r.error });
    }
  }
  return { rules, config: { enabled: opts.enabled ?? true, rules: ruleConfig }, errors };
}

/** A PolicyEngine that knows the built-in rules plus the compiled custom ones. */
export function engineWithStandards(compiled: CompiledStandards): PolicyEngine {
  return new PolicyEngine([...DEFAULT_RULES, ...compiled.rules]);
}
