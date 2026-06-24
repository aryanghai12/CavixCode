import { httpJson, type PlatformConfig, type PostedReview, type PullRef, type ReviewPlatform, type ReviewSubmission } from "./types.ts";

// Azure DevOps (Services or Server). Reviews are "threads"; an inline thread
// carries a threadContext with the file + right-side line range. PAT auth is
// HTTP Basic with an empty username.
export class AzureDevOpsPlatform implements ReviewPlatform {
  readonly name = "azure-devops";
  private readonly cfg: PlatformConfig;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion = "7.1";
  constructor(cfg: PlatformConfig) {
    this.cfg = cfg;
    this.base = cfg.baseUrl ?? "https://dev.azure.com";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }
  private headers() {
    const basic = Buffer.from(`:${this.cfg.token}`).toString("base64");
    return { authorization: `Basic ${basic}`, "content-type": "application/json" };
  }
  // ref.project is "org/project" for Azure DevOps Services.
  private threadsUrl(ref: PullRef): string {
    return `${this.base}/${ref.project}/_apis/git/repositories/${ref.repo}/pullRequests/${ref.number}/threads?api-version=${this.apiVersion}`;
  }
  async fetchDiff(_ref: PullRef): Promise<string> {
    // Azure exposes diffs via the commits/diffs API; omitted here (posting is the
    // adapter's job). The pipeline fetches the diff from its own clone instead.
    throw new Error("azure-devops fetchDiff not implemented; use the sandbox clone");
  }
  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const url = this.threadsUrl(ref);
    const top = await httpJson(this.fetchImpl, url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ comments: [{ parentCommentId: 0, content: review.summary, commentType: "text" }], status: "active" }),
    });
    let inlinePosted = 0;
    for (const c of review.comments) {
      await httpJson(this.fetchImpl, url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          comments: [{ parentCommentId: 0, content: c.body, commentType: "text" }],
          status: "active",
          threadContext: { filePath: "/" + c.path.replace(/^\//, ""), rightFileStart: { line: c.line, offset: 1 }, rightFileEnd: { line: c.line, offset: 1 } },
        }),
      });
      inlinePosted++;
    }
    const b = top.body as { id?: number };
    return { id: String(b.id ?? ""), url: `${this.base}/${ref.project}/_git/${ref.repo}/pullrequest/${ref.number}`, inlinePosted };
  }
}
