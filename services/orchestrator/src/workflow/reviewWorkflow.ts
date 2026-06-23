import type { ReviewJob } from "@cavix/core";
import type { GitHubClient, PostedReview } from "../github/client.ts";
import { refFromJob } from "../github/client.ts";
import type { Reviewer } from "../reviewer/reviewer.ts";
import { buildReviewSubmission } from "../poster/poster.ts";
import type { ReviewHandler } from "./engine.ts";

// The review workflow body: the three durable steps that turn a ReviewJob into a
// posted PR review. Each step is a clean await so a future Temporal port can wrap
// them as activities with their own retries and visibility. Phase 0 covers
// Stage 11's posting; the verification step (Stage 10) will slot between review
// and post once the sandbox lands.

export interface WorkflowLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ReviewWorkflowDeps {
  github: GitHubClient;
  reviewer: Reviewer;
  logger?: WorkflowLogger;
}

export interface ReviewOutcome {
  posted: PostedReview;
  summary: string;
  findingCount: number;
  inlineCount: number;
  offDiffCount: number;
  costUsd: number;
  model: string;
}

const noopLogger: WorkflowLogger = { info() {}, error() {} };

/** Run the full review workflow for one job and return what was posted. */
export async function runReview(job: ReviewJob, deps: ReviewWorkflowDeps): Promise<ReviewOutcome> {
  const log = deps.logger ?? noopLogger;
  const ref = refFromJob(job);
  const base = { repo: job.repo, pr: job.pr_number, head: job.head_sha };

  // Step 1 — fetch the diff.
  const diff = await deps.github.fetchPullDiff(ref);
  log.info("fetched diff", { ...base, bytes: diff.length });

  // Step 2 — single-model review pass through the BYOK gateway.
  const result = await deps.reviewer.review({ org: job.org, title: job.title, diff });
  log.info("review complete", {
    ...base,
    findings: result.findings.length,
    cost_usd: result.costUsd,
    model: result.model,
  });

  // Step 3 — synthesize and post the review.
  const built = buildReviewSubmission(result, diff);
  const posted = await deps.github.postReview(ref, built.submission);
  log.info("review posted", {
    ...base,
    review_id: posted.id,
    url: posted.htmlUrl,
    inline: built.inlineCount,
    off_diff: built.offDiffCount,
  });

  return {
    posted,
    summary: result.summary,
    findingCount: result.findings.length,
    inlineCount: built.inlineCount,
    offDiffCount: built.offDiffCount,
    costUsd: result.costUsd,
    model: result.model,
  };
}

/** Wrap runReview as a WorkflowEngine handler (fire-and-forget per job). */
export function makeReviewHandler(deps: ReviewWorkflowDeps): ReviewHandler {
  return async (job: ReviewJob) => {
    await runReview(job, deps);
  };
}
