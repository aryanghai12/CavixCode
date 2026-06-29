import type { OrgPolicyConfig, RuleConfig } from "./types.ts";

// Per-repo overrides layer on top of the org policy config. A repo can disable
// the whole gate, toggle individual rules, or change a rule's options — without
// touching the org default. (Org owners can mark rules non-overridable; that
// enforcement lives in the control plane.)

export interface RepoPolicyOverride {
  enabled?: boolean;
  rules?: Record<string, Partial<RuleConfig>>;
  disableRules?: string[];
  enableRules?: string[];
}

export function mergeRepoOverride(org: OrgPolicyConfig, override?: RepoPolicyOverride): OrgPolicyConfig {
  if (!override) return org;
  const rules: Record<string, RuleConfig> = {};
  for (const [id, rc] of Object.entries(org.rules)) rules[id] = { ...rc };

  for (const [id, patch] of Object.entries(override.rules ?? {})) {
    rules[id] = { enabled: patch.enabled ?? rules[id]?.enabled ?? false, options: { ...rules[id]?.options, ...patch.options } };
  }
  for (const id of override.enableRules ?? []) rules[id] = { ...rules[id], enabled: true };
  for (const id of override.disableRules ?? []) rules[id] = { ...rules[id], enabled: false };

  return { enabled: override.enabled ?? org.enabled, rules };
}
