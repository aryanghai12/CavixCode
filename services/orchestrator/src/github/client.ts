import type { ReviewJob } from "@cavix/core";

// The GitHubClient port. The orchestrator talks to GitHub only through this, so
// the review workflow is decoupled from the transport: the real REST client and
// the in-process fake are interchangeable, and tests/eval need no network.

export interface PullRef {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  installationId: number;
}

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

export interface InlineComment {
  path: string;
  /** 1-based line in the head (new) file; must be a line present in the diff. */
  line: number;
  body: string;
}

export interface ReviewSubmission {
  /** Top-level review summary (markdown). */
  body: string;
  event: ReviewEvent;
  comments: InlineComment[];
}

export interface PostedReview {
  id: number;
  htmlUrl: string;
}

/**
 * The reaction emojis GitHub accepts. Cavix uses them as the fast, unmistakable
 * "I heard you" signal on the comment that triggered a review:
 *   eyes     👀 — picked up, working on it
 *   rocket   🚀 — review posted
 *   confused 😕 — something went wrong (a comment explains what)
 *   "+1"     👍 — nothing to do (e.g. repo not enabled, or a no-op command)
 */
export type ReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

export interface PullMeta {
  headSha: string;
  baseSha: string;
  title: string;
  draft: boolean;
  state: string;
}

export interface GitHubClient {
  /** Fetch the PR's unified diff (the `application/vnd.github.diff` media type). */
  fetchPullDiff(ref: PullRef): Promise<string>;
  /** Submit a review with a summary and inline comments. */
  postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview>;
  /** Read the PR's current head/base/title — used when a command job has no commit. */
  getPull(ref: PullRef): Promise<PullMeta>;
  /** React to an issue comment (the acknowledgment signal). */
  addReaction(ref: PullRef, commentId: number, content: ReactionContent): Promise<void>;
  /** Post a normal PR conversation comment (status, errors, help, answers). */
  createComment(ref: PullRef, body: string): Promise<{ id: number; htmlUrl: string }>;
}

/**
 * Build a PullRef from a canonical ReviewJob.
 *
 * NOTE: command jobs (an "@cavixcode review" comment) carry no head SHA — the
 * issue_comment payload has no commit. headSha is "" here and the workflow fills
 * it in from getPull() before anything is posted.
 */
export function refFromJob(job: ReviewJob): PullRef {
  const [owner, repo] = job.repo.split("/");
  return {
    owner: owner ?? "",
    repo: repo ?? "",
    number: job.pr_number,
    headSha: job.head_sha ?? "",
    installationId: job.installation_id,
  };
}
