import { httpJson, type PlatformConfig, type PostedReview, type PullRef, type ReviewPlatform, type ReviewSubmission } from "./types.ts";

export class GitHubPlatform implements ReviewPlatform {
  readonly name = "github";
  private readonly cfg: PlatformConfig;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(cfg: PlatformConfig) {
    this.cfg = cfg;
    this.base = cfg.baseUrl ?? "https://api.github.com";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }
  private headers(accept = "application/vnd.github+json") {
    return { authorization: `Bearer ${this.cfg.token}`, accept, "user-agent": "cavix", "content-type": "application/json" };
  }
  async fetchDiff(ref: PullRef): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/repos/${ref.project}/${ref.repo}/pulls/${ref.number}`, {
      headers: this.headers("application/vnd.github.diff"),
    });
    if (!res.ok) throw new Error(`github fetchDiff HTTP ${res.status}`);
    return res.text();
  }
  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const { body } = await httpJson(this.fetchImpl, `${this.base}/repos/${ref.project}/${ref.repo}/pulls/${ref.number}/reviews`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        commit_id: ref.commit,
        body: review.summary,
        event: review.requestChanges ? "REQUEST_CHANGES" : "COMMENT",
        comments: review.comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
      }),
    });
    const b = body as { id?: number; html_url?: string };
    return { id: String(b.id ?? ""), url: b.html_url ?? "", inlinePosted: review.comments.length };
  }

  // ── Review management (for "@cavix review" → dismiss stale, post fresh) ──────

  /** List reviews on the PR authored by a given login (Cavix's bot account). */
  async listOwnReviews(ref: PullRef, botLogin: string): Promise<Array<{ id: number; state: string }>> {
    const { body } = await httpJson(this.fetchImpl, `${this.base}/repos/${ref.project}/${ref.repo}/pulls/${ref.number}/reviews`, { headers: this.headers() });
    const reviews = (body as Array<{ id: number; state: string; user?: { login?: string } }>) ?? [];
    return reviews.filter((r) => r.user?.login === botLogin).map((r) => ({ id: r.id, state: r.state }));
  }

  /** Dismiss a stale review so the PR shows only the fresh one. */
  async dismissReview(ref: PullRef, reviewId: number, message: string): Promise<void> {
    await httpJson(this.fetchImpl, `${this.base}/repos/${ref.project}/${ref.repo}/pulls/${ref.number}/reviews/${reviewId}/dismissals`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ message, event: "DISMISS" }),
    });
  }

  /** Delete a stale inline review comment by id. */
  async deleteReviewComment(ref: PullRef, commentId: number): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/repos/${ref.project}/${ref.repo}/pulls/comments/${commentId}`, { method: "DELETE", headers: this.headers() });
    if (!res.ok && res.status !== 404) throw new Error(`github deleteReviewComment HTTP ${res.status}`);
  }

  // ── Check runs (the merge-gating status the PR shows) ───────────────────────

  async createCheckRun(ref: PullRef, input: CheckRunInput): Promise<{ id: number }> {
    const { body } = await httpJson(this.fetchImpl, `${this.base}/repos/${ref.project}/${ref.repo}/check-runs`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        name: input.name,
        head_sha: ref.commit,
        status: input.status,
        conclusion: input.conclusion,
        output: { title: input.title, summary: input.summary },
      }),
    });
    return { id: (body as { id?: number }).id ?? 0 };
  }

  async updateCheckRun(ref: PullRef, checkRunId: number, input: Partial<CheckRunInput>): Promise<void> {
    await httpJson(this.fetchImpl, `${this.base}/repos/${ref.project}/${ref.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({
        status: input.status,
        conclusion: input.conclusion,
        output: input.title ? { title: input.title, summary: input.summary } : undefined,
      }),
    });
  }
}

// A GitHub Check Run — the ✓/✗ Cavix status a PR displays (and an org can make a
// required check so a failing Cavix gate blocks merge).
export interface CheckRunInput {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "action_required";
  title: string;
  summary: string;
}
