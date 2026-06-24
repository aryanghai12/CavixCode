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
}
