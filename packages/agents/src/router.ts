import type { AgentSpec, ModelRouter, ModelTier } from "./types.ts";

// ConfigModelRouter maps a tier → concrete model, with optional per-agent
// overrides. This is the cost lever: expensive frontier reasoning only where it
// pays (security, correctness, concurrency, breaking changes); cheaper models for
// pattern-y work (standards, test-coverage). All ids are config, not hardcoded.
export interface ModelTierConfig {
  cheap: string;
  frontier: string;
  /** Per-agent tier override, e.g. { "performance": "frontier" }. */
  perAgent?: Record<string, ModelTier>;
}

export class ConfigModelRouter implements ModelRouter {
  private readonly cfg: ModelTierConfig;
  constructor(cfg: ModelTierConfig) {
    this.cfg = cfg;
  }
  modelFor(spec: AgentSpec): string {
    const tier = this.cfg.perAgent?.[spec.id] ?? spec.tier;
    return tier === "frontier" ? this.cfg.frontier : this.cfg.cheap;
  }
}

// Sensible defaults aligned with the baseline (Opus reason / Sonnet build).
export const DEFAULT_TIER_CONFIG: ModelTierConfig = {
  cheap: "claude-sonnet-4-6",
  frontier: "claude-opus-4-8",
};
