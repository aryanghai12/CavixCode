import {
  REVIEW_MARKER,
  type AuthIdentity,
  type CheckRunInput,
  type GitHubClient,
  type OwnReview,
  type PullRef,
  type PostedReview,
  type PullMeta,
  type ReactionContent,
  type ReviewSubmission,
  type WorkflowRun,
} from "./client.ts";

// FakeGitHubClient serves a canned diff and captures every review submitted to
// it. It is what makes the full posting path runnable and assertable offline:
// the captured submission is the exact payload that RestGitHubClient would send
// to GitHub, so the e2e test and the demo log a real review object.

export interface FakeGitHubOptions {
  /** Diff returned by fetchPullDiff for any ref. */
  diff: string;
  /** Head SHA reported by getPull (what a command job resolves to). */
  headSha?: string;
  /** PR title reported by getPull. */
  title?: string;
  /** The PR description as the "author" wrote it. */
  body?: string;
  /** Repo contents at head, keyed by path — what the verifier reads. */
  files?: Record<string, string>;
  /** Report the PR as a draft, so the draft setting can be exercised. */
  draft?: boolean;
  /** Completed CI runs this repo reports, newest first. Stage 6 fixture data. */
  workflowRuns?: WorkflowRun[];
  /**
   * Refuse to create a check run, the way a PAT-backed deployment or an
   * installation without `checks: write` does. Lets a test prove the review
   * still posts when the Checks box is unavailable.
   */
  noChecks?: boolean;
}

export class FakeGitHubClient implements GitHubClient {
  private readonly diff: string;
  private readonly headSha: string;
  private readonly title: string;
  private readonly files: Record<string, string>;
  /** The PR description, as Cavix has left it. Assertable in tests. */
  pullBody: string;
  /** How many times the description was rewritten. */
  bodyWrites = 0;
  readonly submissions: Array<{ ref: PullRef; review: ReviewSubmission }> = [];
  /** Every reaction added, in order — the acknowledgment trail under test. */
  readonly reactions: Array<{ commentId: number; content: ReactionContent }> = [];
  /** Every conversation comment posted (status / error explanations). */
  readonly comments: string[] = [];
  /** How many times an existing comment was EDITED rather than duplicated. */
  commentEdits = 0;
  /**
   * Every state the Cavix check run passed through, in order. A review should
   * always leave exactly two: `in_progress` when the job was picked up, then
   * `completed` with its conclusion.
   */
  readonly checkRuns: Array<{ id: number } & CheckRunInput> = [];
  /** Reviews dismissed, in order, with the reason given. */
  readonly dismissed: Array<{ id: number; message: string }> = [];
  /** Inline review comments deleted, in order. */
  readonly deletedComments: number[] = [];
  private readonly noChecks: boolean;
  private readonly draft: boolean;
  private readonly workflowRuns: WorkflowRun[];
  private readonly commentIds = new Map<number, number>();
  /** Review state per posted review id, so dismissal can behave like GitHub's. */
  private readonly reviewState = new Map<number, string>();
  private seq = 0;

  constructor(opts: FakeGitHubOptions) {
    this.diff = opts.diff;
    this.headSha = opts.headSha ?? "resolvedheadsha";
    this.title = opts.title ?? "Fake pull request";
    this.pullBody = opts.body ?? "";
    this.files = { ...(opts.files ?? {}) };
    this.noChecks = opts.noChecks === true;
    this.draft = opts.draft === true;
    this.workflowRuns = opts.workflowRuns ?? [];
  }

  async fetchPullDiff(_ref: PullRef): Promise<string> {
    return this.diff;
  }

  async getPull(_ref: PullRef): Promise<PullMeta> {
    return {
      headSha: this.headSha,
      baseSha: "basesha",
      baseRef: "main",
      title: this.title,
      draft: this.draft,
      state: "open",
      body: this.pullBody,
    };
  }

  async fetchFile(_ref: PullRef, path: string): Promise<string | null> {
    return this.files[path] ?? null;
  }

  async updatePullBody(_ref: PullRef, body: string): Promise<void> {
    this.pullBody = body;
    this.bodyWrites++;
  }

  async addReaction(_ref: PullRef, commentId: number, content: ReactionContent): Promise<void> {
    this.reactions.push({ commentId, content });
  }

  async createComment(ref: PullRef, body: string): Promise<{ id: number; htmlUrl: string }> {
    this.comments.push(body);
    const id = 5000 + this.comments.length;
    this.commentIds.set(id, this.comments.length - 1);
    return { id, htmlUrl: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}#issuecomment-${id}` };
  }

  async findComment(_ref: PullRef, marker: string): Promise<{ id: number } | null> {
    for (const [id, idx] of this.commentIds) {
      if (this.comments[idx]?.includes(marker)) return { id };
    }
    return null;
  }

  async updateComment(_ref: PullRef, commentId: number, body: string): Promise<void> {
    const idx = this.commentIds.get(commentId);
    if (idx === undefined) throw new Error(`fake github: no comment ${commentId}`);
    this.comments[idx] = body;
    this.commentEdits++;
  }

  async createCheckRun(_ref: PullRef, input: CheckRunInput): Promise<number> {
    if (this.noChecks) return 0; // as GitHub answers a PAT: 403, no check row
    const id = 7000 + this.checkRuns.length + 1;
    this.checkRuns.push({ id, ...input });
    return id;
  }

  async updateCheckRun(_ref: PullRef, checkRunId: number, input: CheckRunInput): Promise<void> {
    if (checkRunId === 0) return;
    this.checkRuns.push({ id: checkRunId, ...input });
  }

  /** The final state of the check run, for assertions and demo logging. */
  lastCheckRun(): ({ id: number } & CheckRunInput) | undefined {
    return this.checkRuns.at(-1);
  }

  async whoAmI(): Promise<AuthIdentity> {
    return { kind: "app", login: "cavixcode[bot]" };
  }

  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    this.seq++;
    const id = 1000 + this.seq;
    this.submissions.push({ ref, review });
    this.reviewState.set(id, review.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED");
    return {
      id,
      htmlUrl: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}#pullrequestreview-${id}`,
    };
  }

  async listTree(_ref: PullRef): Promise<string[]> {
    return Object.keys(this.files);
  }

  async listWorkflowRuns(_ref: PullRef, _branch: string, limit = 60): Promise<WorkflowRun[]> {
    return this.workflowRuns.slice(0, limit);
  }

  async listOwnReviews(_ref: PullRef): Promise<OwnReview[]> {
    return this.submissions
      .map((s, i) => ({ id: 1001 + i, state: this.reviewState.get(1001 + i) ?? "COMMENTED", body: s.review.body }))
      .filter((r) => r.body.includes(REVIEW_MARKER))
      .map(({ id, state }) => ({ id, state }));
  }

  async dismissReview(_ref: PullRef, reviewId: number, message: string): Promise<void> {
    // GitHub refuses to dismiss a COMMENTED review. The fake refuses too, so a
    // test cannot pass against behaviour the real API does not have.
    if (this.reviewState.get(reviewId) !== "CHANGES_REQUESTED") return;
    this.reviewState.set(reviewId, "DISMISSED");
    this.dismissed.push({ id: reviewId, message });
  }

  async listReviewCommentIds(_ref: PullRef, reviewIds: number[]): Promise<number[]> {
    const out: number[] = [];
    for (const id of reviewIds) {
      const idx = id - 1001;
      const sub = this.submissions[idx];
      if (!sub) continue;
      // Deterministic synthetic ids, one per inline comment of that review.
      sub.review.comments.forEach((_, i) => out.push(id * 100 + i));
    }
    return out.filter((id) => !this.deletedComments.includes(id));
  }

  async deleteReviewComment(_ref: PullRef, commentId: number): Promise<void> {
    this.deletedComments.push(commentId);
  }

  /** The most recently posted review, for assertions / demo logging. */
  lastReview(): ReviewSubmission | undefined {
    return this.submissions.at(-1)?.review;
  }
}
