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

export interface GitHubClient {
  /** Fetch the PR's unified diff (the `application/vnd.github.diff` media type). */
  fetchPullDiff(ref: PullRef): Promise<string>;
  /** Submit a review with a summary and inline comments. */
  postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview>;
}

/** Build a PullRef from a canonical ReviewJob. */
export function refFromJob(job: ReviewJob): PullRef {
  const [owner, repo] = job.repo.split("/");
  return {
    owner: owner ?? "",
    repo: repo ?? "",
    number: job.pr_number,
    headSha: job.head_sha,
    installationId: job.installation_id,
  };
}
