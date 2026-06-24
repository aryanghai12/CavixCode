import type { Gateway } from "@cavix/gateway";
import { AGENTS, buildSystemPrompt, buildUserPrompt } from "./prompts.ts";
import { parseAgentReply } from "./parse.ts";
import { ConfigModelRouter, DEFAULT_TIER_CONFIG, type ModelTierConfig } from "./router.ts";
import type { AgentInput, AgentOutput, AgentSpec, EnsembleResult, ModelRouter } from "./types.ts";

export interface EnsembleOptions {
  gateway: Gateway;
  router?: ModelRouter;
  tierConfig?: ModelTierConfig;
  /** Subset of agents to run; defaults to all seven. */
  agents?: AgentSpec[];
  maxTokens?: number;
}

// Run one agent: route to a model, call the BYOK gateway, parse its reply.
export async function runAgent(spec: AgentSpec, input: AgentInput, opts: EnsembleOptions): Promise<AgentOutput> {
  const router = opts.router ?? new ConfigModelRouter(opts.tierConfig ?? DEFAULT_TIER_CONFIG);
  const model = router.modelFor(spec);
  try {
    const { response, cost } = await opts.gateway.complete(input.org, {
      model,
      maxTokens: opts.maxTokens ?? 2048,
      temperature: 0,
      system: buildSystemPrompt(spec),
      messages: [{ role: "user", content: buildUserPrompt(input.title, input.diff, input.contextPrompt) }],
    });
    const parsed = parseAgentReply(response.text, spec);
    return { agentId: spec.id, abstained: parsed.abstained, findings: parsed.findings, model, tier: spec.tier, costUsd: cost.costUsd };
  } catch {
    // A single agent failing must not sink the ensemble — treat as abstain.
    return { agentId: spec.id, abstained: true, findings: [], model, tier: spec.tier, costUsd: 0 };
  }
}

// The ensemble runs all agents in PARALLEL (latency = slowest agent, not the sum).
export class AgentEnsemble {
  private readonly opts: EnsembleOptions;
  private readonly agents: AgentSpec[];

  constructor(opts: EnsembleOptions) {
    this.opts = opts;
    this.agents = opts.agents ?? AGENTS;
  }

  async run(input: AgentInput): Promise<EnsembleResult> {
    const perAgent = await Promise.all(this.agents.map((spec) => runAgent(spec, input, this.opts)));
    const findings = perAgent.flatMap((a) => a.findings);
    const totalCostUsd = round6(perAgent.reduce((s, a) => s + a.costUsd, 0));
    const abstainedAgents = perAgent.filter((a) => a.abstained).map((a) => a.agentId);
    return { findings, perAgent, totalCostUsd, abstainedAgents };
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
