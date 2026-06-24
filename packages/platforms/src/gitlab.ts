import { httpJson, type PlatformConfig, type PostedReview, type PullRef, type ReviewPlatform, type ReviewSubmission } from "./types.ts";

// GitLab (gitlab.com or self-managed CE/EE via baseUrl). MR review = a summary
// note + one discussion per inline comment, anchored by diff position.
export class GitLabPlatform implements ReviewPlatform {
  readonly name = "gitlab";
  private readonly cfg: PlatformConfig;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(cfg: PlatformConfig) {
    this.cfg = cfg;
    this.base = (cfg.baseUrl ?? "https://gitlab.com") + "/api/v4";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }
  private headers() {
    return { "private-token": this.cfg.token, "content-type": "application/json" };
  }
  private projectId(ref: PullRef): string {
    return encodeURIComponent(`${ref.project}/${ref.repo}`);
  }
  async fetchDiff(ref: PullRef): Promise<string> {
    const { body } = await httpJson(this.fetchImpl, `${this.base}/projects/${this.projectId(ref)}/merge_requests/${ref.number}/changes`, { headers: this.headers() });
    const changes = (body as { changes?: Array<{ diff?: string }> }).changes ?? [];
    return changes.map((c) => c.diff ?? "").join("\n");
  }
  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const pid = this.projectId(ref);
    const note = await httpJson(this.fetchImpl, `${this.base}/projects/${pid}/merge_requests/${ref.number}/notes`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ body: review.summary }),
    });
    let inlinePosted = 0;
    for (const c of review.comments) {
      await httpJson(this.fetchImpl, `${this.base}/projects/${pid}/merge_requests/${ref.number}/discussions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          body: c.body,
          position: { position_type: "text", new_path: c.path, new_line: c.line, base_sha: ref.baseCommit, head_sha: ref.commit, start_sha: ref.baseCommit },
        }),
      });
      inlinePosted++;
    }
    const id = String((note.body as { id?: number }).id ?? "");
    return { id, url: `${this.cfg.baseUrl ?? "https://gitlab.com"}/${ref.project}/${ref.repo}/-/merge_requests/${ref.number}`, inlinePosted };
  }
}
