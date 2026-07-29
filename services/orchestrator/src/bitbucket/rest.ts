import {
  INLINE_MARKER,
  REVIEW_MARKER,
  type AuthIdentity,
  type CheckRunInput,
  type DiffLimitation,
  type OwnReview,
  type PlatformCapabilities,
  type PostedReview,
  type PullMeta,
  type PullRef,
  type ReactionContent,
  type ReviewPlatform,
  type ReviewSubmission,
  type WorkflowRun,
} from "../github/client.ts";

// Bitbucket Cloud, the third platform, and the one that tests whether the seam
// generalises past a lucky second.
//
// It does, with one honest subtraction. Everything below is written against the
// same `ReviewPlatform` port as GitHub and GitLab, and the workflow does not
// branch on platform anywhere; what differs is entirely in `capabilities` and in
// the sentences the review prints because of them.
//
// WHAT BITBUCKET CLOUD CANNOT DO
//
//   • No comment reactions. There is no award/reaction API on a pull request
//     comment at all, so the acknowledgment signal ("Cavix picked your command
//     up") has nowhere to go.
//
//   • No repository tree listing worth having. `/src` pages a directory at a
//     time, so mapping a repository is one request per directory, which is a
//     rate-limit budget spent on Stage 5's contract discovery before a review
//     has been posted. Reported false rather than implemented badly.
//
//   • NO CHAT COMMANDS, and this one is a deliberate refusal rather than a gap.
//     A command has to be authorized: Cavix must know the commenter can push
//     before it spends a customer's model budget on their say-so. GitHub sends
//     that in the webhook; GitLab does not, so the GitLab client asks the
//     members API. Bitbucket's equivalent lookup for an ARBITRARY user needs
//     workspace-admin scope that a review bot has no business holding, so
//     `commandsAllowed` returns false and the edge never mints a Bitbucket
//     command job. Automatic reviews on pull request events work fully. A
//     command path that cannot check permission is an open door, and the
//     GitLab session in this repo already found one of those.
//
// Request-changes IS real here, unlike GitLab: Bitbucket has a per-participant
// changes-requested state that branch restrictions can gate a merge on, and it
// is reversible, which is what makes it dismissible.

export const BITBUCKET_CAPABILITIES: PlatformCapabilities = {
  // A commit build status, which branch restrictions can require.
  checkRuns: true,
  reactions: false,
  blockingReview: true,
  deleteInlineComments: true,
  treeListing: false,
  ciHistory: true,
};

export interface BitbucketTokenProvider {
  /** A token for this workspace. Bitbucket has no per-install token to mint. */
  token(workspace: string): Promise<string>;
}

export class StaticBitbucketToken implements BitbucketTokenProvider {
  private readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  async token(): Promise<string> {
    if (!this.value) throw new Error("bitbucket: token is empty");
    return this.value;
  }
}

export interface RestBitbucketOptions {
  tokens: BitbucketTokenProvider;
  /** API root. Only overridden in tests; Bitbucket Cloud has one. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

/** Where a human reads a Bitbucket Cloud repository, as opposed to its API. */
const BITBUCKET_WEB = "https://bitbucket.org";

/** The build status key. Branch restrictions match on it, so it is a constant. */
const STATUS_KEY = "CAVIX";

/** Pipelines read for Stage 6. Each is one request, so this is deliberately small. */
const MAX_PIPELINES = 20;

export class RestBitbucketClient implements ReviewPlatform {
  readonly platform = "bitbucket" as const;
  readonly capabilities = BITBUCKET_CAPABILITIES;
  /**
   * Bitbucket Cloud serves its API from api.bitbucket.org and its pages from
   * bitbucket.org, so this is a constant rather than derived from `baseUrl`
   * (which tests override with a local address).
   */
  readonly webUrl = BITBUCKET_WEB;

  private readonly tokens: BitbucketTokenProvider;
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RestBitbucketOptions["logger"];

  constructor(opts: RestBitbucketOptions) {
    this.tokens = opts.tokens;
    this.api = (opts.baseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger;
  }

  /** `workspace/repo_slug`, each segment encoded. Bitbucket has no nested groups. */
  private repoPath(ref: PullRef): string {
    return `${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  }

  private prPath(ref: PullRef): string {
    return `/repositories/${this.repoPath(ref)}/pullrequests/${ref.number}`;
  }

  private async headers(ref: PullRef): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.tokens.token(ref.owner)}`,
      accept: "application/json",
      "user-agent": "cavix-orchestrator",
    };
  }

  private async json<T>(ref: PullRef, path: string, init: RequestInit = {}): Promise<T | null> {
    const res = await this.fetchImpl(`${this.api}${path}`, {
      ...init,
      headers: { ...(await this.headers(ref)), ...(init.headers ?? {}) },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`bitbucket: ${init.method ?? "GET"} ${path} HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private post<T>(ref: PullRef, path: string, body: unknown): Promise<T | null> {
    return this.json<T>(ref, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private prUrl(ref: PullRef): string {
    return `${BITBUCKET_WEB}/${ref.owner}/${ref.repo}/pull-requests/${ref.number}`;
  }

  // ── the diff ───────────────────────────────────────────────────────────────

  /**
   * A real unified diff, straight from the API.
   *
   * The one place Bitbucket is easier than GitLab: `/diff` returns exactly what
   * `parseUnifiedDiff` wants, with the `diff --git` headers already on it, so
   * nothing has to be reassembled.
   */
  async fetchPullDiff(ref: PullRef): Promise<string> {
    const res = await this.fetchImpl(`${this.api}${this.prPath(ref)}/diff`, {
      headers: await this.headers(ref),
      redirect: "follow", // Bitbucket 302s this to a signed URL
    });
    if (!res.ok) throw new Error(`bitbucket: fetch diff HTTP ${res.status} ${res.statusText}`);
    return res.text();
  }

  /** `/diff` returns the whole unified diff, so nothing is ever left out. */
  diffLimitations(): DiffLimitation[] {
    return [];
  }

  async getPull(ref: PullRef): Promise<PullMeta> {
    const pr = await this.json<{
      title?: string;
      description?: string | null;
      state?: string;
      source?: { commit?: { hash?: string } };
      destination?: { commit?: { hash?: string }; branch?: { name?: string } };
    }>(ref, this.prPath(ref));
    if (!pr) throw new Error(`bitbucket: pull request ${ref.owner}/${ref.repo}#${ref.number} not found`);
    return {
      headSha: pr.source?.commit?.hash ?? "",
      baseSha: pr.destination?.commit?.hash ?? "",
      baseRef: pr.destination?.branch?.name || "main",
      title: pr.title ?? "",
      // Bitbucket has no draft state on a pull request at all, so this is
      // honestly false rather than guessed from a title prefix.
      draft: false,
      state: pr.state === "OPEN" ? "open" : (pr.state ?? "open").toLowerCase(),
      body: pr.description ?? "",
    };
  }

  async fetchFile(ref: PullRef, path: string, sha?: string): Promise<string | null> {
    const commit = sha ?? ref.headSha;
    if (!commit) return null;
    const url =
      `${this.api}/repositories/${this.repoPath(ref)}/src/${encodeURIComponent(commit)}/` +
      path.split("/").map(encodeURIComponent).join("/");
    const res = await this.fetchImpl(url, { headers: await this.headers(ref), redirect: "follow" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`bitbucket: fetch file HTTP ${res.status} ${res.statusText}`);
    return res.text();
  }

  /**
   * Bitbucket's PR update requires the title alongside the description.
   *
   * Sending description alone blanks the title, which would rewrite the one
   * field the author cares most about. So it is read first and echoed back.
   */
  async updatePullBody(ref: PullRef, body: string): Promise<void> {
    const current = await this.getPull(ref);
    await this.json(ref, this.prPath(ref), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: current.title, description: body }),
    });
  }

  // ── the review ─────────────────────────────────────────────────────────────

  /**
   * A summary comment, then one inline comment per finding, then (when asked)
   * the changes-requested flag.
   *
   * Same trade as GitLab: the summary is posted first and its failure is the
   * only fatal one, because the summary names every finding and a review that
   * lost three anchors is still a complete review.
   */
  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const url = `${this.prPath(ref)}/comments`;
    const top = await this.post<{ id?: number }>(ref, url, { content: { raw: review.body } });
    if (!top) throw new Error(`bitbucket: could not post the review comment on #${ref.number}`);

    let posted = 0;
    for (const c of review.comments) {
      try {
        await this.post(ref, url, { content: { raw: c.body }, inline: { path: c.path, to: c.line } });
        posted++;
      } catch {
        // An anchor Bitbucket will not take. The finding is in the summary.
      }
    }
    if (posted < review.comments.length) {
      this.logger?.info("bitbucket refused some inline anchors; the findings are still in the summary", {
        repo: `${ref.owner}/${ref.repo}`,
        pr: ref.number,
        wanted: review.comments.length,
        anchored: posted,
      });
    }

    if (review.event === "REQUEST_CHANGES") {
      try {
        await this.json(ref, `${this.prPath(ref)}/request-changes`, { method: "POST" });
      } catch {
        // The token may not be a participant on this pull request. The comment
        // is posted either way, which is the part that carries the findings.
        this.logger?.info("bitbucket would not accept a changes-requested flag", {
          repo: `${ref.owner}/${ref.repo}`,
          pr: ref.number,
        });
      }
    }

    return { id: top.id ?? 0, htmlUrl: this.prUrl(ref) };
  }

  // ── conversation ───────────────────────────────────────────────────────────

  /** No reaction API exists on Bitbucket Cloud. See `capabilities`. */
  async addReaction(_ref: PullRef, _commentId: number, _content: ReactionContent): Promise<void> {
    return;
  }

  async createComment(ref: PullRef, body: string): Promise<{ id: number; htmlUrl: string }> {
    const c = await this.post<{ id?: number }>(ref, `${this.prPath(ref)}/comments`, { content: { raw: body } });
    return { id: c?.id ?? 0, htmlUrl: this.prUrl(ref) };
  }

  async findComment(ref: PullRef, marker: string): Promise<{ id: number } | null> {
    const page = await this.json<{ values?: Array<{ id: number; content?: { raw?: string } }> }>(
      ref,
      `${this.prPath(ref)}/comments?pagelen=100`,
    );
    const found = (page?.values ?? []).reverse().find((c) => (c.content?.raw ?? "").includes(marker));
    return found ? { id: found.id } : null;
  }

  async updateComment(ref: PullRef, commentId: number, body: string): Promise<void> {
    await this.json(ref, `${this.prPath(ref)}/comments/${commentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: { raw: body } }),
    });
  }

  // ── repository ─────────────────────────────────────────────────────────────

  /**
   * Not available, and deliberately not faked.
   *
   * `/src` pages one directory at a time, so a repository map is one request per
   * directory: a rate-limit budget spent on Stage 5's contract discovery before
   * a review has even been posted. An empty list is what every caller already
   * handles, and `capabilities.treeListing` says why.
   */
  async listTree(): Promise<string[]> {
    return [];
  }

  /**
   * Bitbucket Pipelines, for Stage 6.
   *
   * `duration_in_seconds` is on the list response, so unlike GitLab this needs
   * no follow-up call per run.
   */
  async listWorkflowRuns(ref: PullRef, branch: string, limit = MAX_PIPELINES): Promise<WorkflowRun[]> {
    try {
      const page = await this.json<{
        values?: Array<{
          state?: { result?: { name?: string }; name?: string };
          target?: { ref_name?: string; commit?: { hash?: string } };
          duration_in_seconds?: number;
          completed_on?: string;
        }>;
      }>(
        ref,
        `/repositories/${this.repoPath(ref)}/pipelines/?sort=-created_on&pagelen=${Math.min(50, limit)}` +
          `&target.ref_name=${encodeURIComponent(branch)}`,
      );
      const out: WorkflowRun[] = [];
      for (const p of (page?.values ?? []).slice(0, limit)) {
        const seconds = p.duration_in_seconds;
        // A pipeline that never ran has no duration. Counting it as a
        // zero-second build would drag Stage 6's trend line down for free.
        if (typeof seconds !== "number" || seconds <= 0) continue;
        const result = (p.state?.result?.name ?? p.state?.name ?? "").toUpperCase();
        out.push({
          workflow: "pipeline",
          commit: p.target?.commit?.hash ?? "",
          branch: p.target?.ref_name ?? branch,
          durationMs: seconds * 1000,
          conclusion: result === "SUCCESSFUL" ? "success" : result === "FAILED" ? "failure" : result.toLowerCase() || "unknown",
          at: p.completed_on ?? new Date().toISOString(),
        });
      }
      return out;
    } catch {
      // Pipelines is a separate product a workspace may not have. Ordinary.
      return [];
    }
  }

  // ── cleanup ────────────────────────────────────────────────────────────────

  async listOwnReviews(ref: PullRef): Promise<OwnReview[]> {
    try {
      const page = await this.json<{ values?: Array<{ id: number; content?: { raw?: string } }> }>(
        ref,
        `${this.prPath(ref)}/comments?pagelen=100`,
      );
      return (page?.values ?? [])
        .filter((c) => (c.content?.raw ?? "").includes(REVIEW_MARKER))
        // Bitbucket has no review object, so the state comes from the
        // participant flag rather than the comment. The workflow only acts on
        // CHANGES_REQUESTED, and `dismissReview` below clears it either way.
        .map((c) => ({ id: c.id, state: "CHANGES_REQUESTED" }));
    } catch {
      return [];
    }
  }

  /**
   * Clear the changes-requested flag.
   *
   * Real here, unlike GitLab: Bitbucket's per-participant state is reversible,
   * which is exactly what makes it dismissible. The comment stays, as it does on
   * GitHub, because a posted review body is part of the conversation.
   */
  async dismissReview(ref: PullRef): Promise<void> {
    try {
      await this.json(ref, `${this.prPath(ref)}/request-changes`, { method: "DELETE" });
    } catch {
      /* nothing was blocking, which is the outcome we wanted */
    }
  }

  async listReviewCommentIds(ref: PullRef): Promise<number[]> {
    try {
      const page = await this.json<{ values?: Array<{ id: number; content?: { raw?: string }; inline?: unknown }> }>(
        ref,
        `${this.prPath(ref)}/comments?pagelen=100`,
      );
      return (page?.values ?? [])
        .filter((c) => c.inline !== undefined && (c.content?.raw ?? "").includes(INLINE_MARKER))
        .map((c) => c.id);
    } catch {
      return [];
    }
  }

  async deleteReviewComment(ref: PullRef, commentId: number): Promise<void> {
    try {
      await this.json(ref, `${this.prPath(ref)}/comments/${commentId}`, { method: "DELETE" });
    } catch {
      /* already gone is the outcome we wanted */
    }
  }

  // ── the status row ─────────────────────────────────────────────────────────

  /**
   * A commit build status, which a branch restriction can require.
   *
   * Posting the same `key` against the same commit again moves the existing
   * status on, so there is no separate create and update. Returns 0 on refusal,
   * exactly like GitHub, so the workflow's "no status row here" path is the one
   * already proven.
   */
  async createCheckRun(ref: PullRef, input: CheckRunInput): Promise<number> {
    if (!ref.headSha) return 0;
    try {
      await this.post(
        ref,
        `/repositories/${this.repoPath(ref)}/commit/${encodeURIComponent(ref.headSha)}/statuses/build`,
        statusPayload(input, this.prUrl(ref)),
      );
      // Bitbucket keys a status by (commit, key) rather than returning an id, so
      // 1 means "there is a row"; the workflow only ever tests it for truthiness.
      return 1;
    } catch {
      return 0;
    }
  }

  async updateCheckRun(ref: PullRef, checkRunId: number, input: CheckRunInput): Promise<void> {
    if (!checkRunId || !ref.headSha) return;
    try {
      await this.post(
        ref,
        `/repositories/${this.repoPath(ref)}/commit/${encodeURIComponent(ref.headSha)}/statuses/build`,
        statusPayload(input, input.detailsUrl ?? this.prUrl(ref)),
      );
    } catch {
      /* the review is posted; a stale status row is not worth an error */
    }
  }

  /**
   * Commands are not accepted on Bitbucket. See the note at the top of the file.
   *
   * This is a refusal, not a stub: authorizing an arbitrary commenter needs
   * workspace-admin scope a review bot should not hold, and a command path that
   * cannot check permission lets anyone who can comment spend a customer's model
   * budget. Automatic reviews are unaffected.
   */
  async commandsAllowed(): Promise<boolean> {
    return false;
  }

  async whoAmI(): Promise<AuthIdentity> {
    try {
      const probe: PullRef = { owner: "", repo: "", number: 0, headSha: "", installationId: 0 };
      const me = await this.json<{ username?: string; nickname?: string; type?: string }>(probe, "/user");
      const login = me?.username ?? me?.nickname;
      if (login) return { kind: "user", login };
    } catch {
      /* fall through */
    }
    return { kind: "unknown", login: "" };
  }
}

/**
 * A commit build status body.
 *
 * Bitbucket's states are INPROGRESS / SUCCESSFUL / FAILED / STOPPED. There is no
 * neutral, and the same decision as everywhere else applies: Cavix being unable
 * to run must never freeze a team's merges, so a run that never happened reports
 * SUCCESSFUL with a description that says plainly it did not happen.
 */
function statusPayload(input: CheckRunInput, url: string): Record<string, unknown> {
  const state =
    input.status !== "completed" ? "INPROGRESS" : input.conclusion === "failure" ? "FAILED" : "SUCCESSFUL";
  return {
    key: STATUS_KEY,
    state,
    name: "Cavix Review",
    // Bitbucket caps the description; over the limit it rejects the request.
    description: input.title.slice(0, 140),
    url,
  };
}
