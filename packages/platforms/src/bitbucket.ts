import { httpJson, type PlatformConfig, type PostedReview, type PullRef, type ReviewPlatform, type ReviewSubmission } from "./types.ts";

// Bitbucket CLOUD (api.bitbucket.org). PR comments carry an optional inline anchor.
export class BitbucketCloudPlatform implements ReviewPlatform {
  readonly name = "bitbucket-cloud";
  private readonly cfg: PlatformConfig;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(cfg: PlatformConfig) {
    this.cfg = cfg;
    this.base = cfg.baseUrl ?? "https://api.bitbucket.org/2.0";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }
  private headers() {
    return { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" };
  }
  async fetchDiff(ref: PullRef): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/repositories/${ref.project}/${ref.repo}/pullrequests/${ref.number}/diff`, { headers: this.headers() });
    if (!res.ok) throw new Error(`bitbucket-cloud fetchDiff HTTP ${res.status}`);
    return res.text();
  }
  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const url = `${this.base}/repositories/${ref.project}/${ref.repo}/pullrequests/${ref.number}/comments`;
    const top = await httpJson(this.fetchImpl, url, { method: "POST", headers: this.headers(), body: JSON.stringify({ content: { raw: review.summary } }) });
    let inlinePosted = 0;
    for (const c of review.comments) {
      await httpJson(this.fetchImpl, url, { method: "POST", headers: this.headers(), body: JSON.stringify({ content: { raw: c.body }, inline: { path: c.path, to: c.line } }) });
      inlinePosted++;
    }
    const b = top.body as { id?: number; links?: { html?: { href?: string } } };
    return { id: String(b.id ?? ""), url: b.links?.html?.href ?? "", inlinePosted };
  }
}

// Bitbucket SERVER / Data Center (self-hosted). Different REST surface
// (/rest/api/1.0) and a different inline anchor shape.
export class BitbucketServerPlatform implements ReviewPlatform {
  readonly name = "bitbucket-server";
  private readonly cfg: PlatformConfig;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(cfg: PlatformConfig) {
    if (!cfg.baseUrl) throw new Error("Bitbucket Server requires baseUrl (self-hosted)");
    this.cfg = cfg;
    this.base = cfg.baseUrl + "/rest/api/1.0";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }
  private headers() {
    return { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" };
  }
  async fetchDiff(ref: PullRef): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/projects/${ref.project}/repos/${ref.repo}/pull-requests/${ref.number}.diff`, { headers: this.headers() });
    if (!res.ok) throw new Error(`bitbucket-server fetchDiff HTTP ${res.status}`);
    return res.text();
  }
  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const url = `${this.base}/projects/${ref.project}/repos/${ref.repo}/pull-requests/${ref.number}/comments`;
    const top = await httpJson(this.fetchImpl, url, { method: "POST", headers: this.headers(), body: JSON.stringify({ text: review.summary }) });
    let inlinePosted = 0;
    for (const c of review.comments) {
      await httpJson(this.fetchImpl, url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ text: c.body, anchor: { path: c.path, line: c.line, lineType: "ADDED", fileType: "TO", diffType: "EFFECTIVE" } }),
      });
      inlinePosted++;
    }
    const b = top.body as { id?: number };
    return { id: String(b.id ?? ""), url: `${this.cfg.baseUrl}/projects/${ref.project}/repos/${ref.repo}/pull-requests/${ref.number}`, inlinePosted };
  }
}
