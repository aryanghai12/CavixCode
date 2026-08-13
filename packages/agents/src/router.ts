import type { AgentSpec, ModelRouter, ModelTier } from "./types.ts";
import { NO_SIGNALS, type DiffSignals } from "./signals.ts";

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
  cheap: "claude-sonnet-5",
  frontier: "claude-opus-5",
};

/**
 * Why a request was routed where it was.
 *
 * Recorded on every finding, because "cost per accepted finding" is the only
 * question that matters for a tier map and it cannot be answered afterwards from
 * a log line that says only which model ran.
 */
export interface RouteDecision {
  tier: ModelTier;
  model: string;
  /** One clause, in words a human reads in a dashboard. */
  reason: string;
  /** True when the work escalated a tier above the agent's default. */
  escalated: boolean;
}

/**
 * Routes on the WORK, not only on who is asking.
 *
 * The rule is one-directional and that is the entire design: signals may push a
 * cheap agent UP, and nothing pushes a frontier agent down. A test-coverage
 * agent looking at a two-hundred-caller signature change needs to reason about
 * blast radius whatever its default says; a security agent looking at a README
 * is still a security agent, and quietly demoting it to save a fraction of a
 * cent is how a security review comes back clean because nobody good read it.
 */
export class SignalModelRouter implements ModelRouter {
  private readonly cfg: ModelTierConfig;
  private signals: DiffSignals;
  private readonly decisions = new Map<string, RouteDecision>();

  constructor(cfg: ModelTierConfig, signals: DiffSignals = NO_SIGNALS) {
    this.cfg = cfg;
    this.signals = signals;
  }

  /** Point the router at a new change. Returns itself so it can be chained. */
  withSignals(signals: DiffSignals): this {
    this.signals = signals;
    this.decisions.clear();
    return this;
  }

  modelFor(spec: AgentSpec): string {
    return this.decide(spec).model;
  }

  /** The full decision, for attribution. */
  decide(spec: AgentSpec): RouteDecision {
    const cached = this.decisions.get(spec.id);
    if (cached) return cached;

    const base: ModelTier = this.cfg.perAgent?.[spec.id] ?? spec.tier;
    let tier = base;
    let reason = base === "frontier" ? `${spec.id} reasons at the frontier tier by default` : `${spec.id} is a cheap-tier agent`;

    if (base === "cheap") {
      const escalation = this.escalationFor();
      if (escalation) {
        tier = "frontier";
        reason = escalation;
      }
    }

    const decision: RouteDecision = {
      tier,
      model: tier === "frontier" ? this.cfg.frontier : this.cfg.cheap,
      reason,
      escalated: tier !== base,
    };
    this.decisions.set(spec.id, decision);
    return decision;
  }

  /**
   * The first signal that earns frontier reasoning, or null.
   *
   * Ordered by how badly a cheap model does on each. A blast radius is the
   * strongest: it is the one thing that cannot be seen from the diff at all, so
   * a model that reasons poorly about it fails silently rather than visibly.
   */
  private escalationFor(): string | null {
    const s = this.signals;
    if (s.apiSurfaceChange && s.callerCount > 0) {
      return `an exported signature changed and ${s.callerCount} call ${s.callerCount === 1 ? "site" : "sites"} can reach it`;
    }
    if (s.callerCount >= FRONTIER_CALLERS) return `${s.callerCount} call sites can reach this change`;
    if (s.sensitivePath) return "the change touches a security-sensitive path";
    if (s.concurrency) return "the change coordinates work across tasks, locks or transactions";
    if (s.apiSurfaceChange) return "an exported signature changed";
    if (s.crossFile && s.changedLines >= FRONTIER_LINES) {
      return `${s.changedLines} lines across ${s.fileCount} files`;
    }
    return null;
  }
}

/** Blast radius past which a change stops being local, whoever is reading it. */
const FRONTIER_CALLERS = 10;
/** A multi-file change this large is not a pattern match. */
const FRONTIER_LINES = 200;
