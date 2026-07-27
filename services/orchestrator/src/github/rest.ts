import type {
  AuthIdentity,
  GitHubClient,
  PullRef,
  PostedReview,
  PullMeta,
  ReactionContent,
  ReviewSubmission,
} from "./client.ts";

// RestGitHubClient is the production GitHub transport. It uses fetch (no SDK) and
// obtains a token per call from a TokenProvider. Two providers ship:
//   • GitHubAppTokenProvider (appAuth.ts) — the real product path: mints a
//     short-lived installation token from the App id + private key.
//   • StaticTokenProvider — a PAT or pre-minted token, handy for local runs.

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

  async getPull(ref: PullRef): Promise<PullMeta> {
    const url = `${this.baseUrl}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const res = await this.fetchImpl(url, {
      headers: await this.headers(ref, "application/vnd.github+json"),
    });
    if (!res.ok) {
      throw new Error(`github: get pull HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      title?: string;
      body?: string | null;
      draft?: boolean;
      state?: string;
      head?: { sha?: string };
      base?: { sha?: string };
    };
    return {
      headSha: data.head?.sha ?? "",
      baseSha: data.base?.sha ?? "",
      title: data.title ?? "",
      draft: data.draft === true,
      state: data.state ?? "open",
      body: data.body ?? "",
    };
  }

  /**
   * Read a file at a commit via the contents API.
   *
   * Returns null rather than throwing on 404: asking for a path that isn't there
   * (deleted in this PR, renamed, generated) is an ordinary outcome of walking a
   * diff, and it must not fail a review. Binary and >1MB files also come back
   * null — the API omits `content` for those, and neither is runnable anyway.
   */
  async fetchFile(ref: PullRef, path: string, sha?: string): Promise<string | null> {
    const commit = sha ?? ref.headSha;
    const url =
      `${this.baseUrl}/repos/${ref.owner}/${ref.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}` +
      (commit ? `?ref=${encodeURIComponent(commit)}` : "");
    const res = await this.fetchImpl(url, {
      headers: await this.headers(ref, "application/vnd.github+json"),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`github: fetch file HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { content?: string; encoding?: string; type?: string };
    if (data.type !== "file" || typeof data.content !== "string") return null;
    // Over 1MB GitHub answers with encoding "none" and an empty body. Returning
    // "" there would hand the sandbox an empty file and let it "verify" against
    // nothing, so say plainly that we could not read it.
    if (data.encoding !== "base64") return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  }

  async updatePullBody(ref: PullRef, body: string): Promise<void> {
    const url = `${this.baseUrl}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const res = await this.fetchImpl(url, {
      method: "PATCH",
      headers: {
        ...(await this.headers(ref, "application/vnd.github+json")),
        "content-type": "application/json",
      },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `github: update pull body HTTP ${res.status} ${res.statusText}: ${detail.slice(0, 200)}`,
      );
    }
  }

  async addReaction(ref: PullRef, commentId: number, content: ReactionContent): Promise<void> {
    const url = `${this.baseUrl}/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}/reactions`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...(await this.headers(ref, "application/vnd.github+json")),
        "content-type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    // 200 = reaction already existed, 201 = created. Anything else is a real error.
    if (res.status !== 200 && res.status !== 201) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `github: add reaction HTTP ${res.status} ${res.statusText}: ${detail.slice(0, 200)}`,
      );
    }
  }

  async createComment(ref: PullRef, body: string): Promise<{ id: number; htmlUrl: string }> {
    const url = `${this.baseUrl}/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...(await this.headers(ref, "application/vnd.github+json")),
        "content-type": "application/json",
      },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `github: create comment HTTP ${res.status} ${res.statusText}: ${detail.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as { id: number; html_url: string };
    return { id: data.id, htmlUrl: data.html_url };
  }

  /**
   * Find a comment of ours containing `marker` (a hidden HTML comment). This is
   * what lets a repeated status update EDIT one comment instead of posting a new
   * one each time — without it, three retries meant three identical comments.
   */
  async findComment(ref: PullRef, marker: string): Promise<{ id: number } | null> {
    // Newest first: our status comment is almost always among the last few.
    const url = `${this.baseUrl}/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`;
    const res = await this.fetchImpl(url, {
      headers: await this.headers(ref, "application/vnd.github+json"),
    });
    if (!res.ok) return null; // best-effort: fall back to posting a new comment
    const data = (await res.json()) as Array<{ id: number; body?: string }>;
    const found = [...data].reverse().find((c) => (c.body ?? "").includes(marker));
    return found ? { id: found.id } : null;
  }

  async updateComment(ref: PullRef, commentId: number, body: string): Promise<void> {
    const url = `${this.baseUrl}/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`;
    const res = await this.fetchImpl(url, {
      method: "PATCH",
      headers: {
        ...(await this.headers(ref, "application/vnd.github+json")),
        "content-type": "application/json",
      },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`github: update comment HTTP ${res.status} ${res.statusText}: ${detail.slice(0, 200)}`);
    }
  }

  /**
   * Identify the account behind the token. GET /app succeeds only for an App JWT
   * (so comments will appear as "<slug>[bot]" with the App's own avatar); GET
   * /user succeeds for a PAT, meaning Cavix would post under a HUMAN's name and
   * profile picture. Worth stating clearly at boot rather than leaving to guesswork.
   */
  async whoAmI(): Promise<AuthIdentity> {
    const probe = { owner: "", repo: "", number: 0, headSha: "", installationId: 0 };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/user`, {
        headers: await this.headers(probe, "application/vnd.github+json"),
      });
      if (res.ok) {
        const u = (await res.json()) as { login?: string; type?: string };
        if (u.login) {
          return { kind: u.type === "Bot" ? "app" : "user", login: u.login };
        }
      }
    } catch {
      /* fall through */
    }
    return { kind: "unknown", login: "" };
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
        // Omit commit_id entirely when unknown — GitHub then reviews the PR's
        // latest commit. Sending "" is a 422.
        ...(ref.headSha ? { commit_id: ref.headSha } : {}),
        body: review.body,
        event: review.event,
        // GitHub anchors review comments on the RIGHT (new) side of the diff.
        comments: review.comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: "RIGHT",
          // start_line marks a multi-line comment; GitHub requires it to be
          // strictly before `line` and on a side of its own.
          ...(c.startLine !== undefined && c.startLine < c.line
            ? { start_line: c.startLine, start_side: "RIGHT" }
            : {}),
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
