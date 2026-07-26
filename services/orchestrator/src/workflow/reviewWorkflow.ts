import { isCommandJob, type ReviewJob } from "@cavix/core";
import type { GitHubClient, PostedReview, PullRef } from "../github/client.ts";
import { refFromJob } from "../github/client.ts";
import type { Reviewer } from "../reviewer/reviewer.ts";
import { buildReviewSubmission } from "../poster/poster.ts";
import type { ReviewHandler } from "./engine.ts";

// The review workflow body: the durable steps that turn a ReviewJob into a posted
// PR review. Each step is a clean await so a future Temporal port can wrap them as
// activities with their own retries and visibility.
//
// Acknowledgment contract (what a human sees after typing "@cavixcode review"):
//   👀 eyes      the moment Cavix picks the command up
//   🚀 rocket    the review has been posted
//   👍 +1        understood, but there was nothing to do (repo not enabled, etc.)
//   😕 confused  it failed — a reply comment says why
// The reaction lands before any slow work, so silence always means "the webhook
// never arrived", never "it's thinking". That distinction is the whole point.

export interface WorkflowLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** What the repo gate returns: whether to review, and which Cavix org owns the repo. */
export interface GateDecision {
  enabled: boolean;
  /** Dashboard org that enabled the repo — the BYOK key lives under this id. */
  org?: string;
}

export interface ReviewWorkflowDeps {
  github: GitHubClient;
  reviewer: Reviewer;
  logger?: WorkflowLogger;
  /** Execution gatekeeper: return enabled=false to skip (repo not toggled on). */
  gate?: (fullName: string) => Promise<GateDecision>;
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

/**
 * React to the comment that triggered this job. Best-effort by design: a failed
 * reaction must never fail the review, and reactions only exist for command jobs.
 */
async function react(
  deps: ReviewWorkflowDeps,
  job: ReviewJob,
  ref: PullRef,
  content: Parameters<GitHubClient["addReaction"]>[2],
): Promise<void> {
  if (!isCommandJob(job) || !job.comment_id) return;
  try {
    await deps.github.addReaction(ref, job.comment_id, content);
  } catch (err) {
    deps.logger?.info("could not add reaction (continuing)", {
      repo: job.repo,
      pr: job.pr_number,
      comment_id: job.comment_id,
      reaction: content,
      err: (err as Error).message,
    });
  }
}

/** Best-effort PR comment; never fails the job. */
async function say(deps: ReviewWorkflowDeps, job: ReviewJob, ref: PullRef, body: string): Promise<void> {
  try {
    await deps.github.createComment(ref, body);
  } catch (err) {
    deps.logger?.error("could not post comment", {
      repo: job.repo,
      pr: job.pr_number,
      err: (err as Error).message,
    });
  }
}

/** Run the full review workflow for one job and return what was posted. */
export async function runReview(
  job: ReviewJob,
  deps: ReviewWorkflowDeps,
  overrides: { org?: string } = {},
): Promise<ReviewOutcome> {
  const log = deps.logger ?? noopLogger;
  const ref = refFromJob(job);

  // Step 0 — command jobs carry no commit (issue_comment has none), so resolve
  // the PR's current head before anything that needs it. Posting a review with an
  // empty commit_id is a 422.
  if (!ref.headSha) {
    const meta = await deps.github.getPull(ref);
    if (!meta.headSha) throw new Error(`could not resolve head commit for ${job.repo}#${job.pr_number}`);
    ref.headSha = meta.headSha;
    if (!job.title) job.title = meta.title;
    log.info("resolved head commit for command job", { repo: job.repo, pr: job.pr_number, head: ref.headSha });
  }
  const base = { repo: job.repo, pr: job.pr_number, head: ref.headSha };

  // Step 1 — fetch the diff.
  const diff = await deps.github.fetchPullDiff(ref);
  log.info("fetched diff", { ...base, bytes: diff.length });

  // Step 2 — single-model review pass through the BYOK gateway. The org id comes
  // from the gate (the dashboard workspace that enabled this repo), NOT from the
  // GitHub owner login — those are different names, and using the login meant the
  // org's saved API key was never found.
  const org = overrides.org || job.org;
  const result = await deps.reviewer.review({ org, title: job.title, diff });
  log.info("review complete", {
    ...base,
    org,
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
  const log = deps.logger ?? noopLogger;
  return async (job: ReviewJob) => {
    const ref = refFromJob(job);

    // Acknowledge FIRST, before the gate or any model call, so the person who
    // typed the command sees 👀 within seconds.
    await react(deps, job, ref, "eyes");

    let org: string | undefined;
    if (deps.gate) {
      const decision = await deps.gate(job.repo);
      org = decision.org;
      if (!decision.enabled) {
        log.info("skipped: repository not enabled in the dashboard", { repo: job.repo, pr: job.pr_number });
        await react(deps, job, ref, "+1");
        if (isCommandJob(job)) {
          await say(
            deps,
            job,
            ref,
            `**Cavix is not enabled for \`${job.repo}\`.**\n\n` +
              "Turn it on in the Cavix dashboard under **Repositories**, then comment " +
              "`@cavixcode review` again.",
          );
        }
        return;
      }
    }

    try {
      const outcome = await runReview(job, deps, { org });
      await react(deps, job, ref, "rocket");
      log.info("job complete", {
        repo: job.repo,
        pr: job.pr_number,
        findings: outcome.findingCount,
        url: outcome.posted.htmlUrl,
      });
    } catch (err) {
      const message = (err as Error).message;
      log.error("review failed", { repo: job.repo, pr: job.pr_number, err: message });
      await react(deps, job, ref, "confused");
      if (isCommandJob(job)) {
        await say(
          deps,
          job,
          ref,
          `**Cavix could not finish this review.**\n\n\`\`\`\n${message.slice(0, 500)}\n\`\`\`\n\n` +
            explain(message),
        );
      }
      throw err; // let the engine record/retry the failure
    }
  };
}

/**
 * Turn the failure into something a non-engineer can act on. These are the four
 * misconfigurations that actually happen in practice.
 */
function explain(message: string): string {
  if (/api key is empty|BYOK/i.test(message)) {
    return "It looks like this workspace has no AI key saved. Add one in the dashboard under **AI & BYOK**.";
  }
  if (/installation token|static token is empty|installation id/i.test(message)) {
    return "That is a GitHub App credential problem. Check `CAVIX_APP_ID` and `CAVIX_APP_PRIVATE_KEY` on the orchestrator service, and that the Cavix App is installed on this repository.";
  }
  if (/HTTP 401|HTTP 403/.test(message)) {
    return "Cavix was not allowed to read or write on this repository. Re-check the App's permissions (Pull requests: Read & write, Contents: Read).";
  }
  if (/HTTP 404/.test(message)) {
    return "Cavix could not see that pull request. The App may not be installed on this repository.";
  }
  return "Check the orchestrator service logs for the full error.";
}
