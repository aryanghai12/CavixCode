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

/**
 * The name of Cavix's check run, as it reads in the PR's Checks box.
 *
 * It is a constant because an org marks a check required BY NAME under branch
 * protection. Rename this and every rule pointing at it silently stops matching,
 * which leaves a branch protected by a check that will never run again.
 */
export const CHECK_NAME = "Cavix Review";

export interface InlineComment {
  path: string;
  /** 1-based line in the head (new) file; must be a line present in the diff. */
  line: number;
  /**
   * First line of a multi-line comment, so GitHub highlights the whole range
   * instead of one line. Both ends must be in the diff — the poster only sets
   * this when it has verified that, because a bad start_line 422s the review.
   */
  startLine?: number;
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
 * Hidden marker on every review body Cavix posts.
 *
 * It is how a later run recognises its own earlier reviews so it can clean them
 * up. Matching on the bot's login would be the obvious alternative, but the login
 * differs per deployment (an App slug here, a PAT's human account there), and a
 * self-hosted install that renamed its App would silently stop finding its own
 * work. A marker in the body is stable across all of that. GitHub renders an HTML
 * comment as nothing, so no reader ever sees it.
 */
export const REVIEW_MARKER = "<!-- cavix:review -->";

/** One of Cavix's own past reviews on a pull request. */
export interface OwnReview {
  id: number;
  /** "COMMENTED" | "CHANGES_REQUESTED" | "APPROVED" | "DISMISSED". */
  state: string;
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
  /** The PR description as the author wrote it. Cavix splices its summary in. */
  body: string;
}

/**
 * A GitHub Check Run: the row in the pull request's "Checks" box, next to CI.
 *
 * This is how a reviewer sees that Cavix is working before any comment exists,
 * and how they see it finished afterwards. It starts `in_progress` the moment a
 * job is picked up and ends `completed` when the review is posted.
 *
 * `conclusion` is what an org can gate a merge on by marking the check required:
 *   success  the review is posted and nothing the owner asked to block on failed
 *   failure  the owner turned blocking on, and something they nominated failed
 *   neutral  Cavix could not finish. Treated as passing by required checks, on
 *            purpose: our outage is not a reason to freeze somebody's merges.
 */
export interface CheckRunInput {
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral";
  /** One line, shown next to the check name. GitHub truncates past 255 chars. */
  title: string;
  /** Markdown, shown when the check is expanded. */
  summary: string;
  /** Where "Details" goes. The posted review, once there is one. */
  detailsUrl?: string;
}

export interface GitHubClient {
  /** Fetch the PR's unified diff (the `application/vnd.github.diff` media type). */
  fetchPullDiff(ref: PullRef): Promise<string>;
  /** Submit a review with a summary and inline comments. */
  postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview>;
  /** Read the PR's current head/base/title — used when a command job has no commit. */
  getPull(ref: PullRef): Promise<PullMeta>;
  /**
   * Read one file at a commit. Stage 10 needs the real source to reproduce a
   * finding in the sandbox — the diff alone is not runnable code. Returns null
   * when the path does not exist at that commit (deleted, renamed, or binary).
   */
  fetchFile(ref: PullRef, path: string, sha?: string): Promise<string | null>;
  /**
   * Replace the PR description. Cavix owns only the block between its markers;
   * the caller is responsible for preserving everything the author wrote.
   */
  updatePullBody(ref: PullRef, body: string): Promise<void>;
  /** React to an issue comment (the acknowledgment signal). */
  addReaction(ref: PullRef, commentId: number, content: ReactionContent): Promise<void>;
  /** Post a normal PR conversation comment (status, errors, help, answers). */
  createComment(ref: PullRef, body: string): Promise<{ id: number; htmlUrl: string }>;
  /** Find our own earlier comment by hidden marker, so we can edit instead of repost. */
  findComment(ref: PullRef, marker: string): Promise<{ id: number } | null>;
  /** Edit a comment we posted earlier. */
  updateComment(ref: PullRef, commentId: number, body: string): Promise<void>;
  /** Cavix's own past reviews on this PR, newest last, found by REVIEW_MARKER. */
  listOwnReviews(ref: PullRef): Promise<OwnReview[]>;
  /**
   * Dismiss one of our past reviews.
   *
   * GitHub only allows this for a review in APPROVED or CHANGES_REQUESTED state;
   * a plain COMMENTED review cannot be dismissed or deleted through the API at
   * all. Implementations swallow that refusal, because the case that matters is
   * exactly the one that works: a stale CHANGES_REQUESTED review left blocking a
   * merge after the author already fixed everything.
   */
  dismissReview(ref: PullRef, reviewId: number, message: string): Promise<void>;
  /** Inline comment ids belonging to the given reviews of ours. */
  listReviewCommentIds(ref: PullRef, reviewIds: number[]): Promise<number[]>;
  /** Delete one inline review comment. Idempotent: a missing one is a success. */
  deleteReviewComment(ref: PullRef, commentId: number): Promise<void>;
  /**
   * Open the Cavix row in the PR's Checks box. Returns 0 when the check could
   * not be created, which is an ordinary outcome rather than an error: check
   * runs are a GitHub App feature and need `checks: write`, so a deployment on a
   * personal access token, or an installation that predates the permission, will
   * simply not have one. The review still posts either way.
   */
  createCheckRun(ref: PullRef, input: CheckRunInput): Promise<number>;
  /** Move that row on, most often from "in progress" to its final conclusion. */
  updateCheckRun(ref: PullRef, checkRunId: number, input: CheckRunInput): Promise<void>;
  /** Who are we posting as? Used once at boot to prove the bot has its own identity. */
  whoAmI(): Promise<AuthIdentity>;
}

/** The account Cavix's token belongs to. */
export interface AuthIdentity {
  /** "app" = posts as the GitHub App bot; "user" = posts as a human account. */
  kind: "app" | "user" | "unknown";
  /** Display name: the App slug, or the user login. */
  login: string;
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
