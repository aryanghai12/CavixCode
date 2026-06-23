import type {
  GitHubClient,
  PullRef,
  PostedReview,
  ReviewSubmission,
} from "./client.ts";

// RestGitHubClient is the production GitHub transport. It uses fetch (no SDK) and
// obtains a token per call from a TokenProvider — for a GitHub App that's a
// short-lived installation token minted from the App private key. Phase 0 ships
// a StaticTokenProvider (a PAT or pre-minted installation token from env) so the
// real posting path is runnable today; JWT-based installation-token minting is a
// later, drop-in TokenProvider with no change to this client.

export interface TokenProvider {
  token(installationId: number): Promise<string>;
}

export class StaticTokenProvider implements TokenProvider {
  private readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  async token(): Promise<string> {
    if (!this.value) throw new Error("github: static token is empty");
    return this.value;
  }
}

export interface RestGitHubOptions {
  tokens: TokenProvider;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export class RestGitHubClient implements GitHubClient {
  private readonly tokens: TokenProvider;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: RestGitHubOptions) {
    this.tokens = opts.tokens;
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "cavix-orchestrator";
  }

  private async headers(ref: PullRef, accept: string): Promise<Record<string, string>> {
    const token = await this.tokens.token(ref.installationId);
    return {
      authorization: `Bearer ${token}`,
      accept,
      "user-agent": this.userAgent,
      "x-github-api-version": "2022-11-28",
    };
  }

  async fetchPullDiff(ref: PullRef): Promise<string> {
    const url = `${this.baseUrl}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const res = await this.fetchImpl(url, {
      headers: await this.headers(ref, "application/vnd.github.diff"),
    });
    if (!res.ok) {
      throw new Error(`github: fetch diff HTTP ${res.status} ${res.statusText}`);
    }
    return res.text();
  }

  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const url = `${this.baseUrl}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...(await this.headers(ref, "application/vnd.github+json")),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commit_id: ref.headSha,
        body: review.body,
        event: review.event,
        // GitHub anchors review comments on the RIGHT (new) side of the diff.
        comments: review.comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: "RIGHT",
          body: c.body,
        })),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`github: post review HTTP ${res.status} ${res.statusText}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as { id: number; html_url: string };
    return { id: data.id, htmlUrl: data.html_url };
  }
}
