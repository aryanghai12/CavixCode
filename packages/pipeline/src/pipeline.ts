import type { Finding } from "@cavix/core";
import type { CodeIndex, Embedder } from "@cavix/analyzer";
import { runDeterministic } from "@cavix/deterministic";
import { PolicyEngine, type OrgPolicyConfig } from "@cavix/policy";
import {
  ContextAssembler,
  MapFileReader,
  renderContextPrompt,
  type Compressor,
  type PastDiscussions,
  type ReviewContext,
} from "@cavix/context";
import { AgentEnsemble, type ModelRouter, type ModelTierConfig } from "@cavix/agents";
import { adjudicate } from "@cavix/adjudicator";
import type { Gateway } from "@cavix/gateway";

// The Phase 1 review pipeline: deterministic + policy (Stage 3/3c) ∥ context
// (Stage 4/7) → ensemble (Stage 8) → adjudication (Stage 9). It is the
// context-aware successor to the Phase 0 single pass. Stage 2 (sandbox) hosts the
// clone and any external tools; Stage 10 (verification) will slot between the
// ensemble and adjudication once the verifier lands.

export interface SourceFile {
  path: string;
  content: string;
}

export interface Phase1Deps {
  gateway: Gateway;
  /** Whole-repo index (built at onboarding / incrementally on push). */
  index: CodeIndex;
  /** Repo snapshot for deterministic scanning, policy, and context reads. */
  sourceFiles: SourceFile[];
  policyEngine?: PolicyEngine;
  discussions?: PastDiscussions;
  embedder?: Embedder;
  compressor?: Compressor;
  router?: ModelRouter;
  tierConfig?: ModelTierConfig;
  confidenceThreshold?: number;
  budgetTokens?: number;
}

export interface Phase1Input {
  org: string;
  title: string;
  diff: string;
  /** Org policy gate config — defaults to OFF if omitted. */
  policyConfig?: OrgPolicyConfig;
}

export interface Phase1Result {
  findings: Finding[];
  context: ReviewContext;
  deterministicCount: number;
  policyCount: number;
  ensembleAbstained: string[];
  droppedCount: number;
  clusters: number;
  immutableKept: number;
  totalCostUsd: number;
}

export async function runPhase1Review(input: Phase1Input, deps: Phase1Deps): Promise<Phase1Result> {
  const reader = new MapFileReader(Object.fromEntries(deps.sourceFiles.map((f) => [f.path, f.content])));

  // Stage 3 + 3c (deterministic) and Stage 4/7 (context) run in parallel.
  const policyEngine = deps.policyEngine ?? new PolicyEngine();
  const assembler = new ContextAssembler({
    index: deps.index,
    files: reader,
    discussions: deps.discussions,
    compressor: deps.compressor,
    embedder: deps.embedder,
    budgetTokens: deps.budgetTokens,
  });

  const [deterministic, context] = await Promise.all([
    runDeterministic({ files: deps.sourceFiles }),
    assembler.assemble({ org: input.org, diff: input.diff }),
  ]);

  // Stage 3c policy gate (OFF by default → []).
  const policyFindings = policyEngine.evaluate(
    { files: deps.sourceFiles, index: deps.index },
    input.policyConfig ?? { enabled: false, rules: {} },
  );

  // Stage 8 ensemble, grounded with the assembled cross-file context.
  const ensemble = new AgentEnsemble({ gateway: deps.gateway, router: deps.router, tierConfig: deps.tierConfig });
  const ensembleResult = await ensemble.run({
    org: input.org,
    title: input.title,
    diff: input.diff,
    contextPrompt: renderContextPrompt(context),
  });

  // Stage 9 adjudication over everything.
  const all = [...deterministic.findings, ...ensembleResult.findings, ...policyFindings];
  const adjudicated = adjudicate(all, { confidenceThreshold: deps.confidenceThreshold });

  return {
    findings: adjudicated.findings,
    context,
    deterministicCount: deterministic.findings.length,
    policyCount: policyFindings.length,
    ensembleAbstained: ensembleResult.abstainedAgents,
    droppedCount: adjudicated.dropped.length,
    clusters: adjudicated.clusters,
    immutableKept: adjudicated.immutableKept,
    totalCostUsd: ensembleResult.totalCostUsd,
  };
}
