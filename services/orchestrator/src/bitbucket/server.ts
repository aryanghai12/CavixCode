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
import type { BitbucketTokenProvider } from "./rest.ts";

// Bitbucket Server / Data Center, which shares nothing with Bitbucket Cloud but
// the name.
//
// It is a SEPARATE CLIENT rather than a baseUrl on the Cloud one, and that is
// not a style preference. The two are different products with different REST
// surfaces:
//
//   Cloud                                Server / Data Center
//   /2.0/repositories/{ws}/{slug}        /rest/api/1.0/projects/{KEY}/repos/{slug}
//   {values: [...], next: url}           {values: [...], isLastPage, nextPageStart}
//   inline: {path, to}                   anchor: {path, line, lineType, fileType}
//   comment {content: {raw}}             comment {text}
//   /statuses/build on the commit        /rest/build-status/1.0/commits/{sha}
//   pullrequests/{id}/diff               pull-requests/{id}/diff (text)
//
// Sharing a class between them would mean a branch in every method, which is the
// shape that quietly ships the wrong call to the wrong product. The one thing
// they genuinely share is the token provider, which is imported.
//
// WHAT DATA CENTER CAN DO THAT CLOUD CANNOT: list a repository tree cheaply. Its
// `/files` endpoint pages the whole repository rather than a directory at a time,
// so Stage 5's contract discovery works here.
//
// WHAT IT STILL CANNOT DO: take chat commands, for exactly the reason Cloud
// cannot. Authorizing an arbitrary commenter needs a project-admin permission
// read that a review bot should not hold, so `commandsAllowed` returns false.
// Automatic reviews on pull request events work fully.

export const BITBUCKET_SERVER_CAPABILITIES: PlatformCapabilities = {
  // A build status on the commit, which a merge check can require.
  checkRuns: true,
  reactions: false,
  // A reviewer can be marked NEEDS_WORK, and a merge check can require that no
  // reviewer has. Reversible, so it is dismissible.
  blockingReview: true,
  deleteInlineComments: true,
  treeListing: true,
  ciHistory: false,
};

/** Paths per page, and the page cap. A monorepo must not spend a review's latency. */
const TREE_PAGE = 1000;
const MAX_TREE_PAGES = 10;

/** The build-status key a merge check matches on, so it is a constant. */
const STATUS_KEY = "CAVIX";

export interface RestBitbucketServerOptions {
  tokens: BitbucketTokenProvider;
  /**
   * The instance root, e.g. "https://bitbucket.acme.com". Required: unlike
   * Cloud there is no default host, because every install has its own.
   */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

export class RestBitbucketServerClient implements ReviewPlatform {
  readonly platform = "bitbucket-server" as const;
  readonly capabilities = BITBUCKET_SERVER_CAPABILITIES;
  /** Data Center serves its API and its pages from the same host. */
  readonly webUrl: string;

  private readonly tokens: BitbucketTokenProvider;
  private readonly root: string;
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RestBitbucketServerOptions["logger"];

  constructor(opts: RestBitbucketServerOptions) {
    this.tokens = opts.tokens;
    this.root = opts.baseUrl.replace(/\/+$/, "");
    this.api = `${this.root}/rest/api/1.0`;
    this.webUrl = this.root;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger;
  }

  /**
   * `projects/{KEY}/repos/{slug}`.
   *
   * `owner` is the PROJECT KEY, which Data Center upper-cases and which is not
   * the project's display name. A personal project's key starts with "~" and
   * lives under /users rather than /projects, which is why this branches.
   */
  private repoPath(ref: PullRef): string {
    const owner = ref.owner;
    const scope = owner.startsWith("~") ? "users" : "projects";
    const key = owner.startsWith("~") ? owner.slice(1) : owner;
    return `/${scope}/${encodeURIComponent(key)}/repos/${encodeURIComponent(ref.repo)}`;
  }

  private prPath(ref: PullRef): string {
    return `${this.repoPath(ref)}/pull-requests/${ref.number}`;
  }

  private prUrl(ref: PullRef): string {
    const owner = ref.owner;
    const web = owner.startsWith("~")
      ? `${this.root}/users/${encodeURIComponent(owner.slice(1))}`
      : `${this.root}/projects/${encodeURIComponent(owner)}`;
    return `${web}/repos/${encodeURIComponent(ref.repo)}/pull-requests/${ref.number}/overview`;
  }

  private async headers(ref: PullRef): Promise<Record<string, string>> {
    return {
      // Data Center HTTP access tokens are bearer tokens, unlike Azure's PATs.
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
      throw new Error(
        `bitbucket-server: ${init.method ?? "GET"} ${path} HTTP ${res.status}: ${detail.slice(0, 200)}`,
      );
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

  // ── the diff ───────────────────────────────────────────────────────────────

  /**
   * A real unified diff, from the `.diff` representation of the pull request.
   *
   * Data Center serves it as text/plain at the same path with a `.diff` suffix,
   * so like Cloud (and unlike Azure) nothing has to be computed. `contextLines`
   * is pinned to 3 because that is what `parseUnifiedDiff` and every reader
   * expect; the server's default is configurable per install and a 0 would strip
   * the context every anchor is positioned against.
   */
  async fetchPullDiff(ref: PullRef): Promise<string> {
    const res = await this.fetchImpl(`${this.api}${this.prPath(ref)}.diff?contextLines=3`, {
      headers: { ...(await this.headers(ref)), accept: "text/plain" },
    });
    if (!res.ok) throw new Error(`bitbucket-server: fetch diff HTTP ${res.status} ${res.statusText}`);
    return res.text();
  }

  /** Data Center hands over the whole diff, so nothing is ever left out. */
  diffLimitations(): DiffLimitation[] {
    return [];
  }

  async getPull(ref: PullRef): Promise<PullMeta> {
    const pr = await this.json<{
      title?: string;
      description?: string | null;
      state?: string;
      fromRef?: { latestCommit?: string };
      toRef?: { latestCommit?: string; displayId?: string };
    }>(ref, this.prPath(ref));
    if (!pr) throw new Error(`bitbucket-server: pull request ${ref.owner}/${ref.repo}#${ref.number} not found`);
    return {
      headSha: pr.fromRef?.latestCommit ?? "",
      baseSha: pr.toRef?.latestCommit ?? "",
      baseRef: pr.toRef?.displayId || "main",
      title: pr.title ?? "",
      // Data Center has no draft state on a pull request, so this is honestly
      // false rather than guessed from a "WIP:" title prefix.
      draft: false,
      state: pr.state === "OPEN" ? "open" : (pr.state ?? "open").toLowerCase(),
      body: pr.description ?? "",
    };
  }

  async fetchFile(ref: PullRef, path: string, sha?: string): Promise<string | null> {
    const commit = sha ?? ref.headSha;
    if (!commit) return null;
    const url =
      `${this.api}${this.repoPath(ref)}/raw/${path.split("/").map(encodeURIComponent).join("/")}` +
      `?at=${encodeURIComponent(commit)}`;
    const res = await this.fetchImpl(url, { headers: { ...(await this.headers(ref)), accept: "text/plain" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`bitbucket-server: fetch file HTTP ${res.status} ${res.statusText}`);
    return res.text();
  }

  /**
   * Data Center's pull request update takes the whole object AND a version.
   *
   * The version is optimistic locking: send a stale one and it 409s rather than
   * clobbering somebody's concurrent edit. Sending the description alone would
   * blank the title, which is the same trap Cloud has and which was caught there
   * by writing the test before trusting the call.
   */
  async updatePullBody(ref: PullRef, body: string): Promise<void> {
    const current = await this.json<{ title?: string; version?: number }>(ref, this.prPath(ref));
    if (!current) throw new Error(`bitbucket-server: pull request ${ref.repo}#${ref.number} not found`);
    await this.json(ref, this.prPath(ref), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: current.title,
        description: body,
        version: current.version ?? 0,
      }),
    });
  }

  // ── the review ─────────────────────────────────────────────────────────────

  /**
   * A summary comment, then one anchored comment per finding.
   *
   * Same trade as every other platform without a review object: the summary is
   * posted first and its failure is the only fatal one, because the summary
   * names every finding.
   */
  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const url = `${this.prPath(ref)}/comments`;
    const top = await this.post<{ id?: number }>(ref, url, { text: review.body });
    if (!top) throw new Error(`bitbucket-server: could not post the review comment on #${ref.number}`);

    let posted = 0;
    for (const c of review.comments) {
      try {
        await this.post(ref, url, {
          text: c.body,
          anchor: {
            path: c.path,
            line: c.line,
            // ADDED, not CONTEXT: Cavix only ever anchors to added lines, and a
            // lineType that disagrees with the line is rejected outright.
            lineType: "ADDED",
            fileType: "TO",
          },
        });
        posted++;
      } catch {
        // An anchor the server will not take. The finding is in the summary.
      }
    }
    if (posted < review.comments.length) {
      this.logger?.info("bitbucket data center refused some inline anchors; the findings are still in the summary", {
        repo: `${ref.owner}/${ref.repo}`,
        pr: ref.number,
        wanted: review.comments.length,
        anchored: posted,
      });
    }

    if (review.event === "REQUEST_CHANGES") {
      try {
        await this.setParticipantStatus(ref, "NEEDS_WORK");
      } catch {
        this.logger?.info("bitbucket data center would not accept a needs-work status", {
          repo: `${ref.owner}/${ref.repo}`,
          pr: ref.number,
        });
      }
    }

    return { id: top.id ?? 0, htmlUrl: this.prUrl(ref) };
  }

  /**
   * Mark our own participation NEEDS_WORK or UNAPPROVED.
   *
   * Addressed by the authenticated user's slug rather than by a stored id: one
   * client serves every review this orchestrator runs, and a cached identity
   * would be wrong the moment a deployment changed its token.
   */
  private async setParticipantStatus(ref: PullRef, status: "NEEDS_WORK" | "UNAPPROVED"): Promise<void> {
    const me = await this.whoAmI();
    if (!me.login) return;
    await this.json(ref, `${this.prPath(ref)}/participants/${encodeURIComponent(me.login)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  // ── conversation ───────────────────────────────────────────────────────────

  /** No reaction API on Data Center. See `capabilities`. */
  async addReaction(_ref: PullRef, _commentId: number, _content: ReactionContent): Promise<void> {
    return;
  }

  async createComment(ref: PullRef, body: string): Promise<{ id: number; htmlUrl: string }> {
    const c = await this.post<{ id?: number }>(ref, `${this.prPath(ref)}/comments`, { text: body });
    return { id: c?.id ?? 0, htmlUrl: this.prUrl(ref) };
  }

  async findComment(ref: PullRef, marker: string): Promise<{ id: number } | null> {
    const found = (await this.activityComments(ref)).reverse().find((c) => (c.text ?? "").includes(marker));
    return found?.id ? { id: found.id } : null;
  }

  /**
   * Editing a comment needs its CURRENT version, for the same optimistic-locking
   * reason as the pull request body. A stale version is a 409, not a silent
   * overwrite, which is the behaviour we want.
   */
  async updateComment(ref: PullRef, commentId: number, body: string): Promise<void> {
    const current = await this.json<{ version?: number }>(ref, `${this.prPath(ref)}/comments/${commentId}`);
    await this.json(ref, `${this.prPath(ref)}/comments/${commentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body, version: current?.version ?? 0 }),
    });
  }

  /**
   * Every comment on the pull request, from the activity feed.
   *
   * There is no plain "list comments" endpoint on Data Center: comments arrive
   * as COMMENTED entries in the activity stream, which is also where the anchor
   * lives, so this one call serves finding, listing and deleting.
   */
  private async activityComments(
    ref: PullRef,
  ): Promise<Array<{ id?: number; text?: string; version?: number; anchored: boolean }>> {
    const out: Array<{ id?: number; text?: string; version?: number; anchored: boolean }> = [];
    try {
      const page = await this.json<{
        values?: Array<{
          action?: string;
          commentAnchor?: unknown;
          comment?: { id?: number; text?: string; version?: number };
        }>;
      }>(ref, `${this.prPath(ref)}/activities?limit=200`);
      for (const a of page?.values ?? []) {
        if (a.action !== "COMMENTED" || !a.comment) continue;
        out.push({ ...a.comment, anchored: a.commentAnchor !== undefined && a.commentAnchor !== null });
      }
    } catch {
      /* a comment list we cannot read costs the cleanup, never the review */
    }
    return out;
  }

  // ── repository ─────────────────────────────────────────────────────────────

  /**
   * Every file path at a commit.
   *
   * `/files` pages the whole repository rather than one directory at a time,
   * which is the difference from Cloud and the reason `treeListing` is true
   * here. Capped, because this runs on somebody else's server.
   */
  async listTree(ref: PullRef, sha?: string): Promise<string[]> {
    const commit = sha ?? ref.headSha;
    if (!commit) return [];
    const out: string[] = [];
    try {
      let start = 0;
      for (let page = 0; page < MAX_TREE_PAGES; page++) {
        const res = await this.json<{ values?: string[]; isLastPage?: boolean; nextPageStart?: number }>(
          ref,
          `${this.repoPath(ref)}/files?at=${encodeURIComponent(commit)}&limit=${TREE_PAGE}&start=${start}`,
        );
        if (!res || !res.values || res.values.length === 0) break;
        out.push(...res.values);
        if (res.isLastPage !== false || typeof res.nextPageStart !== "number") break;
        start = res.nextPageStart;
      }
    } catch {
      // A partial map is worth having; a missing one must never fail a review.
    }
    return out;
  }

  /**
   * No CI history.
   *
   * Data Center has no built-in pipeline product: teams point Bamboo, Jenkins or
   * something else at it and report back through the build-status API, which
   * records a state and a URL and no duration. Stage 6 measures a duration
   * trend, so there is nothing here to measure and `ciHistory` says so rather
   * than this returning plausible-looking zeros.
   */
  async listWorkflowRuns(): Promise<WorkflowRun[]> {
    return [];
  }

  // ── cleanup ────────────────────────────────────────────────────────────────

  async listOwnReviews(ref: PullRef): Promise<OwnReview[]> {
    return (await this.activityComments(ref))
      .filter((c) => (c.text ?? "").includes(REVIEW_MARKER) && c.id)
      // Data Center has no review object; the blocking state is the participant
      // flag, which `dismissReview` clears. The workflow only acts on
      // CHANGES_REQUESTED, so reporting it here is what makes the clear happen.
      .map((c) => ({ id: c.id as number, state: "CHANGES_REQUESTED" }));
  }

  /**
   * Clear our NEEDS_WORK participation.
   *
   * Idempotent and reversible, which is what makes it dismissible at all. Called
   * once per past review the workflow found, so it is written to be cheap to
   * repeat rather than to be called exactly once.
   */
  async dismissReview(ref: PullRef): Promise<void> {
    try {
      await this.setParticipantStatus(ref, "UNAPPROVED");
    } catch {
      /* nothing was blocking, which is the outcome we wanted */
    }
  }

  async listReviewCommentIds(ref: PullRef): Promise<number[]> {
    return (await this.activityComments(ref))
      .filter((c) => c.anchored && (c.text ?? "").includes(INLINE_MARKER) && c.id)
      .map((c) => c.id as number);
  }

  /**
   * Delete an inline comment.
   *
   * The version is required and is optimistic locking again: deleting at a stale
   * version is refused rather than racing somebody's edit.
   */
  async deleteReviewComment(ref: PullRef, commentId: number): Promise<void> {
    try {
      const current = await this.json<{ version?: number }>(ref, `${this.prPath(ref)}/comments/${commentId}`);
      if (!current) return; // already gone is the outcome we wanted
      await this.json(ref, `${this.prPath(ref)}/comments/${commentId}?version=${current.version ?? 0}`, {
        method: "DELETE",
      });
    } catch {
      /* already gone, or edited under us; neither is worth failing a review */
    }
  }

  // ── the status row ─────────────────────────────────────────────────────────

  /**
   * A commit build status, which a merge check can require.
   *
   * It lives under `/rest/build-status/1.0`, NOT under the core API, so it does
   * not go through `json()`. Posting the same key against the same commit again
   * moves the existing status on, so there is no separate create and update.
   * Returns 0 on refusal, exactly like GitHub.
   */
  async createCheckRun(ref: PullRef, input: CheckRunInput): Promise<number> {
    if (!ref.headSha) return 0;
    try {
      const res = await this.fetchImpl(
        `${this.root}/rest/build-status/1.0/commits/${encodeURIComponent(ref.headSha)}`,
        {
          method: "POST",
          headers: { ...(await this.headers(ref)), "content-type": "application/json" },
          body: JSON.stringify(statusPayload(input, this.prUrl(ref))),
        },
      );
      // Keyed by (commit, key) rather than returning an id, so 1 means "there is
      // a row"; the workflow only ever tests this for truthiness.
      return res.ok ? 1 : 0;
    } catch {
      return 0;
    }
  }

  async updateCheckRun(ref: PullRef, checkRunId: number, input: CheckRunInput): Promise<void> {
    if (!checkRunId || !ref.headSha) return;
    try {
      await this.fetchImpl(`${this.root}/rest/build-status/1.0/commits/${encodeURIComponent(ref.headSha)}`, {
        method: "POST",
        headers: { ...(await this.headers(ref)), "content-type": "application/json" },
        body: JSON.stringify(statusPayload(input, input.detailsUrl ?? this.prUrl(ref))),
      });
    } catch {
      /* the review is posted; a stale status row is not worth an error */
    }
  }

  /**
   * Commands are not accepted, for the same reason as Bitbucket Cloud.
   *
   * Deciding whether an arbitrary commenter may push means reading the
   * repository's permission list, which needs project-admin rights a review bot
   * should not hold. A command path that cannot check permission is an open
   * door. Automatic reviews are unaffected.
   */
  async commandsAllowed(): Promise<boolean> {
    return false;
  }

  /**
   * Who the token belongs to.
   *
   * Data Center has no "/user" endpoint. It returns the authenticated user's
   * name in the `X-AUSERNAME` RESPONSE HEADER of every authenticated REST call,
   * which is the documented way to ask, so this makes the cheapest call it can
   * and reads the header rather than the body. An unauthenticated request gets
   * the same header with the value "anonymous", which is reported as unknown
   * rather than as a login.
   */
  async whoAmI(): Promise<AuthIdentity> {
    try {
      const probe: PullRef = { owner: "", repo: "", number: 0, headSha: "", installationId: 0 };
      const res = await this.fetchImpl(`${this.api}/projects?limit=1`, { headers: await this.headers(probe) });
      const login = res.headers.get("x-ausername") ?? "";
      if (login && login.toLowerCase() !== "anonymous") return { kind: "user", login };
    } catch {
      /* fall through */
    }
    return { kind: "unknown", login: "" };
  }
}

/**
 * A build-status body.
 *
 * Data Center's states are INPROGRESS / SUCCESSFUL / FAILED. There is no
 * neutral, and the same decision as every other platform applies: Cavix being
 * unable to run must never freeze a team's merges, so a run that never happened
 * reports SUCCESSFUL with a description that says plainly it did not happen.
 */
function statusPayload(input: CheckRunInput, url: string): Record<string, unknown> {
  const state =
    input.status !== "completed" ? "INPROGRESS" : input.conclusion === "failure" ? "FAILED" : "SUCCESSFUL";
  return {
    key: STATUS_KEY,
    state,
    name: "Cavix Review",
    url,
    description: input.title.slice(0, 255),
  };
}
