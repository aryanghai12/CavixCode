import type { Finding } from "@cavix/core";

// Stage 8 — the multi-agent ensemble. Each agent is a focused reviewer with one
// mission, a default model tier, and the discipline to ABSTAIN when unsure (so
// the ensemble's recall comes from breadth, not from each agent guessing).

export type ModelTier = "cheap" | "frontier";

export interface AgentSpec {
  id: string;
  /** Default finding category for this agent. */
  category: string;
  tier: ModelTier;
  /** What this agent hunts for — becomes the core of its system prompt. */
  mission: string;
}

export interface AgentInput {
  org: string;
  title: string;
  diff: string;
  /** Assembled Stage 7 context (cross-file snippets, discussions). */
  contextPrompt: string;
}

export interface AgentOutput {
  agentId: string;
  abstained: boolean;
  findings: Finding[];
  model: string;
  tier: ModelTier;
  costUsd: number;
}

export interface EnsembleResult {
  findings: Finding[];
  perAgent: AgentOutput[];
  totalCostUsd: number;
  abstainedAgents: string[];
}

export interface ModelRouter {
  /** Resolve the concrete model id for an agent given its tier. */
  modelFor(spec: AgentSpec): string;
}
