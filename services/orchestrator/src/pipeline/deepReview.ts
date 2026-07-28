import type { Finding } from "@cavix/core";
import { CodeIndex, HeuristicParser } from "@cavix/analyzer";
import { runPhase1Review } from "@cavix/pipeline";
import type { Gateway } from "@cavix/gateway";
import type { GitHubClient, PullRef } from "../github/client.ts";
import { changedPaths, fetchSources } from "../sources.ts";

// Stages 3, 4, 7, 8 and 9, on a real pull request.
//
// These stages have existed in packages/ since Phase 1 and, until now, ran
// nowhere except their own tests and the eval harness. The live service reviewed
// every pull request with one model and one prompt over the raw diff. The eval
// scores that path at 81.8% F1 with an 18.2% false-positive rate, and the
// pipeline path at 95.7% with 8.3%, so the gap was not theoretical: it was the
// difference between the product we describe and the product that ran.
//
// What the pipeline adds over the single pass:
//   Stage 3  deterministic linters, SAST and secret scanning, free and exact
//   Stage 4  a call graph of the fetched files, so a finding can be about the
//            caller of the changed line rather than only the changed line
//   Stage 7  context assembly and compression, so the agents get a dense brief
//   Stage 8  seven specialist agents in parallel instead of one generalist
//   Stage 9  dedupe, voting and a confidence threshold over everything above
//
// It is a STEP, injected like verification is, for the same reason: the workflow
// must keep working when it is absent (a deployment that has not enabled it) and
// when it throws (a bad index, a provider outage mid-ensemble). Both fall back to
// the single-model pass rather than failing the review.

export interface DeepReviewInput {
  org: string;
  title: string;
  diff: string;
  ref: PullRef;
  /**
   * Stage 12 — this workspace's learned per-category confidence bars, derived
   * from its own accept and reject history.
   *
   * It arrives PER REVIEW rather than being baked in at boot, because it is a
   * property of the org and this step is shared by every org the deployment
   * serves. It rides along on the review-config call the workflow already makes,
   * so a calibrated review costs the same number of round trips as an
   * uncalibrated one. Absent (a workspace with no history, an unreachable
   * control-plane) means Stage 9 uses its own default, which is what every
   * review did before this existed.
   */
  thresholdByCategory?: Record<string, number>;
}

export interface DeepReviewResult {
  findings: Finding[];
  /** What each stage contributed, for the log and the Scope module. */
  deterministicCount: number;
  /** Scanners that executed. NOT the finding count: a clean repo runs them all. */
  toolsRun: number;
  /**
   * Did the scanners see every changed file? False on a pull request wider than
   * the per-review file budget. The caller must not claim a full deterministic
   * pass when this is false.
   */
  fullyScanned: boolean;
  ensembleAgents: number;
  abstained: string[];
  droppedCount: number;
  /**
   * Categories whose confidence bar came from this workspace's own decisions
   * rather than the default. 0 on a workspace that has not taught Cavix
   * anything yet, which is every workspace on day one.
   */
  calibratedCategories: number;
  /** Symbols the Stage 4 index resolved across the fetched files. */
  astSymbols: number;
  filesIndexed: number;
  costUsd: number;
}

export type DeepReviewStep = (input: DeepReviewInput) => Promise<DeepReviewResult>;

export interface DeepReviewOptions {
  gateway: Gateway;
  github: GitHubClient;
  /**
   * The deployment-wide floor below which Stage 9 drops a finding. The
   * pipeline's own default applies when unset. A workspace's learned
   * per-category bars (Stage 12) arrive on the INPUT, not here, and override
   * this for the categories they cover.
   */
  confidenceThreshold?: number;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Build the step. Returns null when the pipeline cannot run at all, so a caller
 * can decide once at boot rather than per review.
 */
export function makeDeepReviewStep(opts: DeepReviewOptions): DeepReviewStep {
  return async (input: DeepReviewInput): Promise<DeepReviewResult> => {
    // Stage 2's job in the reference architecture is a full clone. Here we read
    // the changed files through the API instead: bounded, no clone, and enough
    // for the graph to resolve calls between the files this PR actually touches.
    // A full-repo index belongs to the onboarding indexer, not to a hot path that
    // has to answer inside a pull request's attention span.
    const paths = changedPaths(input.diff);
    if (paths.length === 0) throw new Error("no readable paths in the diff");

    // A wide pull request reads its first MAX_SOURCE_FILES files and runs anyway.
    //
    // Refusing outright was the first thing this did, and it was wrong: any PR
    // touching thirteen files fell all the way back to one model over the raw
    // diff, which is most real pull requests. Stage 8 reads the DIFF, not these
    // files, so the seven agents lose nothing; only the graph and the scanners
    // see less. Partial file coverage is a smaller loss than no ensemble at all.
    //
    // What it must not do is then CLAIM full coverage, so `fullyScanned` is
    // reported and the caller drops the Deterministic Pass row when it is false.
    const sourceFiles = await fetchSources(opts.github, input.ref, paths);
    if (sourceFiles.length === 0) throw new Error("could not read any of the changed files");
    const fullyScanned = sourceFiles.length === paths.length;
    if (!fullyScanned) {
      opts.logger?.info("deep review is reading part of a wide change", {
        repo: `${input.ref.owner}/${input.ref.repo}`,
        pr: input.ref.number,
        changed_files: paths.length,
        files_read: sourceFiles.length,
        note: "the agents still see the whole diff; the graph and scanners see these files",
      });
    }

    // Stage 4 — parse and resolve the call graph over what we fetched.
    const index = new CodeIndex(new HeuristicParser());
    index.indexFiles(sourceFiles);

    const learned = input.thresholdByCategory ?? {};
    const result = await runPhase1Review(
      { org: input.org, title: input.title, diff: input.diff },
      {
        gateway: opts.gateway,
        index,
        sourceFiles,
        ...(opts.confidenceThreshold !== undefined ? { confidenceThreshold: opts.confidenceThreshold } : {}),
        ...(Object.keys(learned).length > 0 ? { thresholdByCategory: learned } : {}),
      },
    );

    // Counted per file rather than asked of the index as a whole: the index does
    // not expose a global list, and summing the files we indexed is the same
    // number without widening a package's public surface for one metric.
    const astSymbols = sourceFiles.reduce((n, f) => n + index.symbolsInFile(f.path).length, 0);
    opts.logger?.info("deep review complete", {
      repo: `${input.ref.owner}/${input.ref.repo}`,
      pr: input.ref.number,
      files_indexed: sourceFiles.length,
      ast_symbols: astSymbols,
      tools_run: result.toolsRun.length,
      tools_skipped: result.toolsSkipped.length,
      deterministic: result.deterministicCount,
      abstained: result.ensembleAbstained.length,
      dropped: result.droppedCount,
      surfaced: result.findings.length,
      calibrated_categories: Object.keys(learned).length,
      cost_usd: result.totalCostUsd,
    });

    return {
      findings: result.findings,
      deterministicCount: result.deterministicCount,
      toolsRun: result.toolsRun.length,
      fullyScanned,
      // Seven specialists run; the ones that had nothing to say abstain.
      ensembleAgents: 7 - result.ensembleAbstained.length,
      abstained: result.ensembleAbstained,
      droppedCount: result.droppedCount,
      calibratedCategories: Object.keys(learned).length,
      astSymbols,
      filesIndexed: sourceFiles.length,
      costUsd: result.totalCostUsd,
    };
  };
}
