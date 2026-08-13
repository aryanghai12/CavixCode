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
import { screen } from "@cavix/critic";
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
  /**
   * Stage 12's learned per-category bars for this workspace. Absent categories
   * fall back to `confidenceThreshold`. See the adjudicator for why only moved
   * categories appear.
   */
  thresholdByCategory?: Record<string, number>;
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
  /**
   * Scanners that actually executed, by name. Distinct from
   * `deterministicCount`, which counts findings: a clean repo runs every tool and
   * reports nothing, and a caller that wants to say "24 tools ran" must not read
   * that number off the findings.
   */
  toolsRun: string[];
  toolsSkipped: string[];
  policyCount: number;
  ensembleAbstained: string[];
  /**
   * Findings the critic could not support against the material the reviewer was
   * shown: a phantom file, a line past the end of one, a symbol that exists
   * nowhere. Dropped before clustering, so agreement could not rescue them.
   */
  unsupportedCount: number;
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

  // Stage 8b — the critic's deterministic screen, before adjudication.
  //
  // It reads each draft finding against the material the reviewer was actually
  // shown and answers one question: does that material support this claim? No
  // model is called, so it runs on every finding of every review at no cost and
  // with no variance.
  //
  // It has to run BEFORE clustering. Adjudication treats independent agreement
  // as confirmation and raises confidence for it, and for models of one family
  // reading one context that independence is largely fictional: they agree on
  // the same hallucination and the bonus pushes it past the threshold. Agreement
  // is evidence about the models, not about the code.
  const all = [...deterministic.findings, ...ensembleResult.findings, ...policyFindings];
  const reports = screen(all, {
    diff: input.diff,
    knownSymbols: deps.index.allSymbolNames?.() ?? [],
    contextText: renderContextPrompt(context),
  });
  //
  // Two outcomes, and they are not the same thing. UNSUPPORTED is a fact about
  // the claim (no such file, no such line) and the finding is dropped.
  // REPAIRABLE means the claim may well be true and the corpus simply does not
  // carry it, so it is trusted LESS and still posted. Deleting somebody's bug
  // report on a partial corpus would be worse than the hallucination this is
  // trying to catch.
  const objections = new Map<Finding, string>();
  const screened = all.map((f, i) => {
    const r = reports[i];
    if (!r) return f;
    const exempt = f.source !== "llm" || f.immutable === true;
    if (r.verdict === "UNSUPPORTED" && !exempt) {
      objections.set(f, r.objection);
      return f;
    }
    if (r.confidenceFactor < 1 && !exempt) {
      return { ...f, confidence: Math.round(f.confidence * r.confidenceFactor * 100) / 100 };
    }
    return f;
  });

  const adjudicated = adjudicate(screened, {
    confidenceThreshold: deps.confidenceThreshold,
    thresholdByCategory: deps.thresholdByCategory,
    unsupported: (f) => {
      const reason = objections.get(f);
      return reason ? `critic: ${reason}` : undefined;
    },
  });

  return {
    findings: adjudicated.findings,
    unsupportedCount: objections.size,
    context,
    deterministicCount: deterministic.findings.length,
    toolsRun: deterministic.toolsRun,
    toolsSkipped: deterministic.toolsSkipped,
    policyCount: policyFindings.length,
    ensembleAbstained: ensembleResult.abstainedAgents,
    droppedCount: adjudicated.dropped.length,
    clusters: adjudicated.clusters,
    immutableKept: adjudicated.immutableKept,
    totalCostUsd: ensembleResult.totalCostUsd,
  };
}
