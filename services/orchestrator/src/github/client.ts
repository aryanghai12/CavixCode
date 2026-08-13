import type { ReviewJob } from "@cavix/core";

// The ReviewPlatform port. The orchestrator talks to a code host only through
// this, so the review workflow is decoupled from the transport: the real REST
// clients, and the in-process fake, are interchangeable and tests need no
// network.
//
// WHY THIS IS ONE INTERFACE AND NOT FIVE
//
// The port grew up as `GitHubClient` and picked up check runs, reactions, review
// dismissal, inline-comment deletion and tree listing, none of which mean the
// same thing on GitLab, Bitbucket or Azure DevOps. The obvious fix is to carve
// it into a small core plus optional methods, and it is the wrong one: it makes
// every call site a `?.` with a fallback, and it invites a second, quieter bug
// where the fallback is silently worse than the real thing.
//
// Instead the shape stays whole and the RISKY methods already have a documented
// "I could not do this" return: `createCheckRun` returns 0, `listTree` and
// `listWorkflowRuns` return [], `dismissReview` swallows a refusal. Every caller
// has handled those since long before a second platform existed, because GitHub
// itself refuses them routinely (a PAT cannot write a check run; a COMMENTED
// review cannot be dismissed by anyone).
//
// So the only thing that was actually missing is a way for the product to SAY
// which of them are real on the platform it is talking to. That is
// `capabilities`. Without it a GitLab review would simply be quieter than a
// GitHub one and nobody would be told why, which is the failure this codebase
// exists to avoid.

/** Which code host a client speaks to. */
export type PlatformName = "github" | "gitlab" | "bitbucket" | "bitbucket-server" | "azure-devops";

/**
 * A file the client could not produce an exact diff for, and why.
 *
 * This exists for exactly one platform. Every other host hands over a unified
 * diff it computed itself; Azure DevOps returns a list of CHANGED PATHS with no
 * content, so Cavix diffs the two versions of each file locally and a file can
 * be too large, too rewritten, or binary. The alternative to reporting those is
 * producing an approximate diff, and an approximate diff does not fail loudly:
 * it silently anchors findings to lines they do not belong to.
 *
 * So the file is left out of the review and NAMED on it. A review that quietly
 * skipped two files is claiming coverage it does not have.
 */
export interface DiffLimitation {
  path: string;
  /** One sentence, printed verbatim on the pull request. */
  reason: string;
}

/**
 * What this platform can actually do, as opposed to what the interface permits.
 *
 * Each flag is false where the platform has no equivalent concept, not merely
 * where this deployment lacks a permission: a GitHub App without `checks: write`
 * still reports `checkRuns: true`, because the feature exists and the operator
 * can grant it. The review says so on the pull request either way, so a reader
 * never has to wonder whether a missing section is a bug.
 */
export interface PlatformCapabilities {
  /**
   * A status row in the merge request's own checks UI, which an org can make
   * required. GitHub has check runs; GitLab has commit statuses, which appear in
   * the pipeline widget and can gate a merge but are not the same object.
   */
  checkRuns: boolean;
  /** An emoji acknowledgment on the comment that triggered the job. */
  reactions: boolean;
  /**
   * A review that BLOCKS the merge and can later be dismissed. GitHub has
   * CHANGES_REQUESTED. GitLab has approvals and pipeline status, and no concept
   * of a bot review holding the merge button that a human can then dismiss, so
   * blocking there has to be expressed some other way or not claimed at all.
   */
  blockingReview: boolean;
  /** Deleting our own inline comments, so a re-review does not stack. */
  deleteInlineComments: boolean;
  /** Listing every path in the repository at a commit. Stage 5 needs it. */
  treeListing: boolean;
  /** Reading completed CI runs on a branch. Stage 6's only data source. */
  ciHistory: boolean;
}

/** Everything present, which is GitHub. The baseline the product was built on. */
export const FULL_CAPABILITIES: PlatformCapabilities = {
  checkRuns: true,
  reactions: true,
  blockingReview: true,
  deleteInlineComments: true,
  treeListing: true,
  ciHistory: true,
};

export interface PullRef {
  /**
   * The namespace that owns the repository: a GitHub owner, or a GitLab group
   * path which may itself be nested ("group/subgroup").
   */
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  /**
   * GitHub App installation, used to mint a short-lived token. 0 on every other
   * platform, which authenticate with a token held per workspace instead.
   */
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

/**
 * The same idea on an INLINE comment body.
 *
 * GitHub does not need it: a review comment carries `pull_request_review_id`, so
 * our own inline comments are found by asking which review they belong to. No
 * other platform has a review to belong to. GitLab's anchored notes are just
 * notes, so the only durable way to recognise our own is the one that already
 * works for the summary. Renders as nothing, on every platform.
 */
export const INLINE_MARKER = "<!-- cavix:inline -->";

/** One of Cavix's own inline comments, as read back off the pull request. */
export interface OwnInlineComment {
  id: number;
  body: string;
  path?: string;
  line?: number;
}

/** One of Cavix's own past reviews on a pull request. */
export interface OwnReview {
  id: number;
  /** "COMMENTED" | "CHANGES_REQUESTED" | "APPROVED" | "DISMISSED". */
  state: string;
}

/**
 * One completed CI run, as GitHub Actions reports it. Stage 6's raw material.
 *
 * `durationMs` is computed here rather than stored by GitHub: the API gives a
 * start and an end, and every consumer wants the difference.
 */
export interface WorkflowRun {
  /** The workflow's name, so two pipelines are never averaged together. */
  workflow: string;
  commit: string;
  branch: string;
  durationMs: number;
  /** "success" | "failure" | "cancelled" | "timed_out" | "skipped". */
  conclusion: string;
  /** When the run finished, ISO 8601. */
  at: string;
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
  /**
   * The branch this pull request targets ("main", "develop"). Stage 6 measures
   * CI history on it, because a pipeline's trend belongs to the branch it runs
   * on and this PR's own runs are a handful of points on a branch that will not
   * exist next week.
   */
  baseRef: string;
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

export interface ReviewPlatform {
  /** Which code host this client speaks to. Named on the review's footer. */
  readonly platform: PlatformName;
  /** What this platform can do. See PlatformCapabilities: it is a promise about
   * the HOST, not about this deployment's permissions. */
  readonly capabilities: PlatformCapabilities;
  /**
   * The BROWSER root of the instance this client talks to, with no trailing
   * slash: "https://github.com", "https://gitlab.example.com",
   * "https://dev.azure.com/acme".
   *
   * It is not the API root and the two are routinely different: GitHub's API
   * lives on api.github.com and its files on github.com, and a GitHub Enterprise
   * install puts the API under /api/v3 of the same host. This is the one the
   * poster needs, because every file and line in a review is a link a human
   * clicks.
   *
   * It exists because the poster used to hardcode github.com. Every permalink in
   * every GitLab and Bitbucket review pointed at a github.com repository that
   * does not exist, which is worse than no link: a reader who follows it either
   * gets a 404 or, on a name collision, somebody else's code.
   */
  readonly webUrl: string;
  /** Fetch the PR's unified diff (the `application/vnd.github.diff` media type). */
  fetchPullDiff(ref: PullRef): Promise<string>;
  /**
   * Files the LAST `fetchPullDiff` for this ref left out, and why.
   *
   * Returns [] on every platform that hands over a real diff, which is all of
   * them but Azure DevOps, so callers need no branch: an empty list means "the
   * diff is the whole change", which is the ordinary case.
   *
   * Synchronous and keyed by ref rather than held on the client, because ONE
   * client instance serves every review this orchestrator runs concurrently. A
   * plain field here would report whichever pull request happened to finish
   * last, which is the shape of a bug this repo has already had once.
   */
  diffLimitations(ref: PullRef): DiffLimitation[];
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
  /**
   * Every file path in the repository at a commit, in one call.
   *
   * Stage 5 needs to FIND the contract files (openapi.json, *.proto, *.graphql)
   * before it can read them, and there is no other way to do that without
   * cloning. Returns an empty list rather than throwing when the tree cannot be
   * read or GitHub truncated it: a partial map is worth having and a missing one
   * must never fail a review.
   */
  listTree(ref: PullRef, sha?: string): Promise<string[]>;
  /**
   * Completed CI runs on a branch, newest first. Stage 6's only data source.
   *
   * Returns an empty list rather than throwing when Actions is disabled, the App
   * lacks the permission, or the repository simply has no CI. All three are
   * ordinary and none of them is worth failing a review over.
   */
  listWorkflowRuns(ref: PullRef, branch: string, limit?: number): Promise<WorkflowRun[]>;
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
  /**
   * Cavix's own inline comments on this pull request, WITH their bodies.
   *
   * Optional, so a platform client that has no way to read them is simply a
   * client that does not reconcile comments; it posts a fresh set as it always
   * did. The bodies are the point: each one carries the hidden fingerprint of
   * the finding it was written for, which is the only way to tell "this comment
   * is already on the page" from "this is a new problem".
   */
  listOwnInlineComments?(ref: PullRef): Promise<OwnInlineComment[]>;
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
  /**
   * May this user run Cavix commands on this repository?
   *
   * GitHub answers true without a request, and that is correct rather than
   * lazy: its webhook carries the commenter's association with the repository,
   * so the EDGE already refused anything below OWNER/MEMBER/COLLABORATOR before
   * the job was ever queued.
   *
   * No other platform sends that. GitLab's note payload has no association
   * field at all, so without this check any account that can comment on a
   * merge request could spend a customer's model budget by typing
   * "@cavixcode review" in a loop. The check therefore lives here, where the
   * API can actually answer it, and it runs for every command job on every
   * platform so there is no association string to special-case.
   */
  commandsAllowed(ref: PullRef, username: string): Promise<boolean>;
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
  // Split at the LAST slash, not the first.
  //
  // On GitHub a full name has exactly one slash, so this is identical. On GitLab
  // a project can live in a nested group, and "acme/platform/billing" split at
  // the first slash gives owner "acme" and repo "platform", silently dropping
  // the project and pointing every API call at a repository that is not the one
  // under review. The namespace is everything before the final segment.
  const cut = job.repo.lastIndexOf("/");
  return {
    owner: cut === -1 ? "" : job.repo.slice(0, cut),
    repo: cut === -1 ? job.repo : job.repo.slice(cut + 1),
    number: job.pr_number,
    headSha: job.head_sha ?? "",
    installationId: job.installation_id,
  };
}
