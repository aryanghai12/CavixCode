import { buildUnifiedDiff, type FileVersions } from "@cavix/differ";
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

// Azure DevOps, the fourth platform, and the only one that is not mechanical.
//
// The seam held for GitLab and for Bitbucket: a client against `ReviewPlatform`,
// a `capabilities` declaration, a normalizer in the Go edge, one line in
// `main.ts`. It holds here too. What does not carry over is the diff.
//
// THE DIFF, WHICH IS THE WHOLE OF THE WORK
//
// Every other host hands Cavix a unified diff. Azure's `diffs/commits` returns a
// list of CHANGED PATHS and a change type, and no content whatsoever. So the
// diff has to be produced here, from the two versions of each file, and
// everything downstream treats it as exact: `commentableLines` decides which
// lines a comment may anchor to, a finding's line number is where a human is
// sent, and the sandbox reproduces a bug at a coordinate that came from it.
//
// Three decisions, each made against a cheaper one:
//
//   1. `@cavix/differ` is Myers' published algorithm, verified line for line
//      against `git diff -U3` on insertions, deletions, added and deleted files,
//      reindents, and repeated-line files (the case a greedy scan gets wrong).
//      A "close enough" differ does not fail; it moves findings onto the wrong
//      lines and nothing in the system can tell.
//   2. A file the differ cannot handle exactly is REFUSED and named on the
//      review, never approximated. See `diffLimitations`.
//   3. The file budget is a hard cap. Two content reads per changed path means a
//      500-file pull request is a thousand requests on a customer's rate limit
//      before a review is posted, so the first MAX_DIFF_FILES are diffed and the
//      rest are reported as not reviewed.
//
// WHAT AZURE CANNOT DO
//
//   • NO CHAT COMMANDS, for the same reason as Bitbucket and by the same
//     deliberate refusal. A command has to be authorized before it spends a
//     customer's model budget, and answering "may this arbitrary user push to
//     this repository?" on Azure needs Graph or Security namespace scopes a
//     review bot has no business holding. `commandsAllowed` returns false and
//     the edge mints no command job. Automatic reviews work fully.
//
//   • No blocking review. Azure has reviewer VOTES, but a bot can only vote if
//     it has been added as a reviewer on that pull request, which nobody will
//     have done. Blocking is expressed as a pull request STATUS that a branch
//     policy can require, exactly as on GitLab, and `blockingReview: false`
//     makes the review say so rather than letting an owner believe there is a
//     gate that is not there.
//
//   • No reactions. Azure has a comment "like" and no emoji vocabulary, and
//     with commands refused there is nothing to acknowledge anyway.

export const AZURE_CAPABILITIES: PlatformCapabilities = {
  // A pull request status, which a branch policy can make required.
  checkRuns: true,
  reactions: false,
  blockingReview: false,
  deleteInlineComments: true,
  // `items?recursionLevel=full` returns the whole tree in one call, unlike
  // Bitbucket's directory-at-a-time paging.
  treeListing: true,
  // Azure Pipelines builds.
  ciHistory: true,
};

/** Azure's REST version. Pinned: an unpinned call gets whatever is newest. */
const API_VERSION = "7.1";

/**
 * Changed files diffed per pull request.
 *
 * Each one costs TWO content reads (the base version and the head version), so
 * this is the tightest budget of any client here. Sixty files is a large pull
 * request by any measure and already a hundred and twenty requests.
 */
const MAX_DIFF_FILES = 60;

/** Content reads in flight. Enough to hide latency, small enough to be polite. */
const FETCH_CONCURRENCY = 6;

/** Builds read for Stage 6. */
const MAX_BUILDS = 50;

/** Azure caps a status description; over it the whole request is rejected. */
const MAX_STATUS_DESCRIPTION = 400;

/** The status name a branch policy matches on, so it is a constant. */
const STATUS_GENRE = "cavix";
const STATUS_NAME = "review";

export interface AzureTokenProvider {
  /** A token for this workspace. Azure has no per-install token to mint. */
  token(org: string): Promise<string>;
}

export interface RestAzureOptions {
  tokens: AzureTokenProvider;
  /** Instance root. Server (on-premises) installs are not dev.azure.com. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
  /** Overridden only in tests, to keep a fixture small. */
  maxDiffFiles?: number;
}

/** One entry of Azure's `diffs/commits` response, narrowed. */
interface AzureChange {
  item?: { path?: string; gitObjectType?: string; isFolder?: boolean };
  changeType?: string;
  sourceServerItem?: string;
}

export class RestAzureClient implements ReviewPlatform {
  readonly platform = "azure-devops" as const;
  readonly capabilities = AZURE_CAPABILITIES;
  /** Azure serves its API and its pages from the same host. */
  readonly webUrl: string;

  private readonly tokens: AzureTokenProvider;
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RestAzureOptions["logger"];
  private readonly maxDiffFiles: number;
  /**
   * Files left out of the diff, keyed by project/pr/head.
   *
   * Keyed, not a field. One client serves every review this orchestrator runs
   * concurrently, so a bare list would report whichever pull request finished
   * last, under another customer's review. The GitLab client learned this the
   * expensive way with its refused-anchor counter.
   */
  private readonly limitations = new Map<string, DiffLimitation[]>();

  constructor(opts: RestAzureOptions) {
    this.tokens = opts.tokens;
    this.root = (opts.baseUrl ?? "https://dev.azure.com").replace(/\/+$/, "");
    this.webUrl = this.root;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger;
    this.maxDiffFiles = opts.maxDiffFiles ?? MAX_DIFF_FILES;
  }

  /**
   * `owner` is "organization/project" and `repo` is the repository.
   *
   * `refFromJob` splits the job's full name at the LAST slash, so
   * "acme/payments/billing-api" gives owner "acme/payments" and repo
   * "billing-api", which is exactly the shape Azure's URLs want. Splitting at
   * the first slash instead is the bug that broke nested GitLab groups.
   */
  private org(ref: PullRef): string {
    return ref.owner.split("/")[0] ?? "";
  }

  private gitApi(ref: PullRef): string {
    // encodeURI, not encodeURIComponent: owner carries a slash on purpose.
    return `${this.root}/${encodeURI(ref.owner)}/_apis/git/repositories/${encodeURIComponent(ref.repo)}`;
  }

  private prPath(ref: PullRef): string {
    return `${this.gitApi(ref)}/pullrequests/${ref.number}`;
  }

  private prUrl(ref: PullRef): string {
    return `${this.root}/${encodeURI(ref.owner)}/_git/${encodeURIComponent(ref.repo)}/pullrequest/${ref.number}`;
  }

  private limitKey(ref: PullRef): string {
    return `${ref.owner}/${ref.repo}!${ref.number}@${ref.headSha}`;
  }

  /**
   * Azure authenticates a personal access token as HTTP Basic with an empty
   * username. A Bearer header is silently accepted and then behaves as an
   * anonymous request on public projects, which is the worst of both: it works
   * in a demo and 404s on the private repository a customer actually has.
   */
  private async headers(ref: PullRef): Promise<Record<string, string>> {
    const pat = await this.tokens.token(this.org(ref));
    return {
      authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
      accept: "application/json",
      "user-agent": "cavix-orchestrator",
    };
  }

  private withVersion(url: string): string {
    return `${url}${url.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
  }

  private async json<T>(ref: PullRef, url: string, init: RequestInit = {}): Promise<T | null> {
    const res = await this.fetchImpl(this.withVersion(url), {
      ...init,
      headers: { ...(await this.headers(ref)), ...(init.headers ?? {}) },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `azure: ${init.method ?? "GET"} ${redact(url)} HTTP ${res.status}: ${detail.slice(0, 200)}`,
      );
    }
    const text = await res.text();
    // Azure answers an unauthenticated request to a private project with a 203
    // and a sign-in HTML page rather than a 401. Parsing that as JSON throws
    // something unreadable, so it is named here instead.
    if (text.trimStart().startsWith("<")) {
      throw new Error(`azure: HTTP 401 (the instance returned a sign-in page for ${redact(url)}; check the access token)`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private post<T>(ref: PullRef, url: string, body: unknown): Promise<T | null> {
    return this.json<T>(ref, url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── the diff ───────────────────────────────────────────────────────────────

  /**
   * The part that is genuinely different: build the unified diff ourselves.
   *
   * `diffs/commits` names the changed paths between the target and source
   * commits; each one is then read at both commits and diffed locally. Files the
   * differ refuses, and files past the budget, are recorded against this ref and
   * reported on the review by `diffLimitations` rather than being dropped.
   */
  async fetchPullDiff(ref: PullRef): Promise<string> {
    const meta = await this.getPull(ref);
    const head = ref.headSha || meta.headSha;
    const base = meta.baseSha;
    if (!head) throw new Error(`azure: pull request ${ref.repo}!${ref.number} has no source commit`);
    if (!base) throw new Error(`azure: pull request ${ref.repo}!${ref.number} has no target commit to diff against`);

    const listed = await this.json<{ changes?: AzureChange[]; allChangesIncluded?: boolean }>(
      ref,
      `${this.gitApi(ref)}/diffs/commits?baseVersion=${encodeURIComponent(base)}&baseVersionType=commit` +
        `&targetVersion=${encodeURIComponent(head)}&targetVersionType=commit&$top=1000`,
    );
    if (!listed) throw new Error(`azure: could not read the changes on ${ref.repo}!${ref.number}`);

    const changes = (listed.changes ?? []).filter(isFileChange);
    const limitations: DiffLimitation[] = [];

    // Azure caps `diffs/commits` itself and says so. A review over a change we
    // only partly listed must not claim to have seen the whole of it.
    if (listed.allChangesIncluded === false) {
      limitations.push({
        path: "(some files)",
        reason: "Azure DevOps truncated its own list of changed files for this pull request",
      });
    }

    const budgeted = changes.slice(0, this.maxDiffFiles);
    for (const c of changes.slice(this.maxDiffFiles)) {
      limitations.push({
        path: pathOf(c),
        reason: `beyond the ${this.maxDiffFiles} files Cavix diffs per pull request`,
      });
    }

    const versions = await this.readVersions(ref, budgeted, base, head, limitations);
    const built = buildUnifiedDiff(versions);
    limitations.push(...built.unrendered);

    if (limitations.length > 0) {
      if (this.limitations.size >= MAX_TRACKED_REVIEWS) {
        const oldest = this.limitations.keys().next().value;
        if (oldest !== undefined) this.limitations.delete(oldest);
      }
      this.limitations.set(this.limitKey(ref), limitations);
      this.logger?.info("azure: some files could not be diffed exactly and are named on the review", {
        repo: ref.repo,
        pr: ref.number,
        changed: changes.length,
        diffed: versions.length - built.unrendered.length,
        left_out: limitations.length,
      });
    } else {
      this.limitations.delete(this.limitKey(ref));
    }

    return built.diff;
  }

  diffLimitations(ref: PullRef): DiffLimitation[] {
    return this.limitations.get(this.limitKey(ref)) ?? [];
  }

  /** Read both versions of every changed file, with bounded concurrency. */
  private async readVersions(
    ref: PullRef,
    changes: AzureChange[],
    base: string,
    head: string,
    limitations: DiffLimitation[],
  ): Promise<FileVersions[]> {
    const out: FileVersions[] = [];
    for (let i = 0; i < changes.length; i += FETCH_CONCURRENCY) {
      const batch = await Promise.all(
        changes.slice(i, i + FETCH_CONCURRENCY).map(async (c): Promise<FileVersions | null> => {
          const path = pathOf(c);
          if (path === "") return null;
          const kind = (c.changeType ?? "edit").toLowerCase();
          const added = kind.includes("add");
          const deleted = kind.includes("delete");
          const oldPath = stripLeadingSlash(c.sourceServerItem ?? "") || path;
          try {
            const [before, after] = await Promise.all([
              added ? Promise.resolve(null) : this.fetchFile(ref, oldPath, base),
              deleted ? Promise.resolve(null) : this.fetchFile(ref, path, head),
            ]);
            // A path Azure listed as changed whose content we could not read on
            // EITHER side is reported, not silently treated as an empty file:
            // "" on one side renders as a whole-file addition or deletion the
            // pull request does not contain.
            if (before === null && after === null && !added && !deleted) {
              limitations.push({ path, reason: "neither version of this file could be read from Azure DevOps" });
              return null;
            }
            return { path, ...(oldPath !== path ? { oldPath } : {}), before, after };
          } catch (err) {
            limitations.push({ path, reason: `could not be read from Azure DevOps (${(err as Error).message.slice(0, 80)})` });
            return null;
          }
        }),
      );
      for (const v of batch) if (v) out.push(v);
    }
    return out;
  }

  async getPull(ref: PullRef): Promise<PullMeta> {
    const pr = await this.json<{
      title?: string;
      description?: string | null;
      status?: string;
      isDraft?: boolean;
      targetRefName?: string;
      lastMergeSourceCommit?: { commitId?: string };
      lastMergeTargetCommit?: { commitId?: string };
    }>(ref, this.prPath(ref));
    if (!pr) throw new Error(`azure: pull request ${ref.repo}!${ref.number} not found`);
    return {
      headSha: pr.lastMergeSourceCommit?.commitId ?? "",
      // The target branch tip at the last merge evaluation, which is what Azure's
      // own diff view compares against.
      baseSha: pr.lastMergeTargetCommit?.commitId ?? "",
      baseRef: stripRefsHeads(pr.targetRefName ?? "") || "main",
      title: pr.title ?? "",
      draft: pr.isDraft === true,
      state: pr.status === "active" ? "open" : (pr.status ?? "open").toLowerCase(),
      body: pr.description ?? "",
    };
  }

  async fetchFile(ref: PullRef, path: string, sha?: string): Promise<string | null> {
    const commit = sha ?? ref.headSha;
    if (!commit) return null;
    const url = this.withVersion(
      `${this.gitApi(ref)}/items?path=${encodeURIComponent(`/${stripLeadingSlash(path)}`)}` +
        `&versionDescriptor.version=${encodeURIComponent(commit)}&versionDescriptor.versionType=commit` +
        `&includeContent=true&$format=text`,
    );
    const res = await this.fetchImpl(url, {
      headers: { ...(await this.headers(ref)), accept: "text/plain" },
    });
    // A path that does not exist at that commit is ordinary while walking a
    // diff (added in this PR, renamed, deleted) and must never fail a review.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`azure: fetch file HTTP ${res.status} ${res.statusText}`);
    return res.text();
  }

  async updatePullBody(ref: PullRef, body: string): Promise<void> {
    await this.json(ref, this.prPath(ref), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: body }),
    });
  }

  // ── the review ─────────────────────────────────────────────────────────────

  /**
   * A summary thread, then one anchored thread per finding.
   *
   * Azure has THREADS rather than reviews: there is no single submission
   * carrying a body and N inline comments. Same trade as GitLab and Bitbucket,
   * for the same reason: the summary goes first and its failure is the only
   * fatal one, because the summary names every finding, so a review that lost
   * three anchors is still a complete review with three fewer conveniences.
   */
  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const url = `${this.prPath(ref)}/threads`;
    const summary = await this.post<{ id?: number }>(ref, url, {
      comments: [{ parentCommentId: 0, content: review.body, commentType: "text" }],
      status: "active",
    });
    if (!summary) throw new Error(`azure: could not post the review thread on !${ref.number}`);

    let posted = 0;
    for (const c of review.comments) {
      try {
        await this.post(ref, url, {
          comments: [{ parentCommentId: 0, content: c.body, commentType: "text" }],
          status: "active",
          threadContext: {
            // Azure wants a repository-absolute path with a leading slash, and
            // rejects the thread outright without one.
            filePath: `/${stripLeadingSlash(c.path)}`,
            // `rightFile*` is the head side, matching every other platform:
            // Cavix only ever anchors to added lines. Offsets are 1-based
            // columns, and the end offset must be past the start or Azure
            // records a zero-width anchor that renders nowhere.
            rightFileStart: { line: c.startLine ?? c.line, offset: 1 },
            rightFileEnd: { line: c.line, offset: 2 },
          },
        });
        posted++;
      } catch {
        // An anchor Azure will not take (the line moved, the file is not in
        // this iteration). The finding is already named in the summary.
      }
    }
    if (posted < review.comments.length) {
      this.logger?.info("azure refused some inline anchors; the findings are still in the summary", {
        repo: ref.repo,
        pr: ref.number,
        wanted: review.comments.length,
        anchored: posted,
      });
    }

    return { id: summary.id ?? 0, htmlUrl: this.prUrl(ref) };
  }

  // ── conversation ───────────────────────────────────────────────────────────

  /** Azure has a comment "like" and no emoji vocabulary. See `capabilities`. */
  async addReaction(_ref: PullRef, _commentId: number, _content: ReactionContent): Promise<void> {
    return;
  }

  async createComment(ref: PullRef, body: string): Promise<{ id: number; htmlUrl: string }> {
    const thread = await this.post<{ id?: number }>(ref, `${this.prPath(ref)}/threads`, {
      comments: [{ parentCommentId: 0, content: body, commentType: "text" }],
      status: "active",
    });
    return { id: thread?.id ?? 0, htmlUrl: this.prUrl(ref) };
  }

  /**
   * Find one of our own threads by hidden marker.
   *
   * The THREAD id is returned rather than the comment id, because that is what
   * `updateComment` needs to address the first comment of it, and the workflow
   * only ever round-trips this value back to us.
   */
  async findComment(ref: PullRef, marker: string): Promise<{ id: number } | null> {
    const page = await this.listThreads(ref);
    // Newest last on Azure, and our status thread is almost always among them.
    const found = [...page].reverse().find((t) => firstContent(t).includes(marker));
    return found?.id ? { id: found.id } : null;
  }

  async updateComment(ref: PullRef, threadId: number, body: string): Promise<void> {
    const thread = (await this.listThreads(ref)).find((t) => t.id === threadId);
    const commentId = thread?.comments?.[0]?.id;
    if (!commentId) return;
    await this.json(ref, `${this.prPath(ref)}/threads/${threadId}/comments/${commentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: body }),
    });
  }

  private async listThreads(ref: PullRef): Promise<AzureThread[]> {
    const page = await this.json<{ value?: AzureThread[] }>(ref, `${this.prPath(ref)}/threads`);
    return page?.value ?? [];
  }

  // ── repository ─────────────────────────────────────────────────────────────

  /**
   * Every blob path at a commit, in one call.
   *
   * `recursionLevel=full` walks the whole tree server-side, so unlike Bitbucket
   * this costs one request rather than one per directory.
   */
  async listTree(ref: PullRef, sha?: string): Promise<string[]> {
    const commit = sha ?? ref.headSha;
    if (!commit) return [];
    try {
      const page = await this.json<{ value?: Array<{ path?: string; isFolder?: boolean; gitObjectType?: string }> }>(
        ref,
        `${this.gitApi(ref)}/items?scopePath=/&recursionLevel=full` +
          `&versionDescriptor.version=${encodeURIComponent(commit)}&versionDescriptor.versionType=commit`,
      );
      return (page?.value ?? [])
        .filter((i) => i.isFolder !== true && i.gitObjectType !== "tree" && i.path)
        .map((i) => stripLeadingSlash(i.path as string));
    } catch {
      // A partial map is worth having; a missing one must never fail a review.
      return [];
    }
  }

  /**
   * Completed Azure Pipelines builds on a branch, as Stage 6's run history.
   *
   * A different API area from git, so it does not hang off `gitApi`. The list
   * response carries start and finish times, so unlike GitLab this needs no
   * follow-up call per run.
   */
  async listWorkflowRuns(ref: PullRef, branch: string, limit = MAX_BUILDS): Promise<WorkflowRun[]> {
    try {
      const page = await this.json<{
        value?: Array<{
          definition?: { name?: string };
          sourceVersion?: string;
          sourceBranch?: string;
          result?: string;
          startTime?: string;
          finishTime?: string;
        }>;
      }>(
        ref,
        `${this.root}/${encodeURI(ref.owner)}/_apis/build/builds?statusFilter=completed` +
          `&branchName=${encodeURIComponent(`refs/heads/${stripRefsHeads(branch)}`)}` +
          `&$top=${Math.min(MAX_BUILDS, limit)}&queryOrder=finishTimeDescending`,
      );
      const out: WorkflowRun[] = [];
      for (const b of (page?.value ?? []).slice(0, limit)) {
        const start = Date.parse(b.startTime ?? "");
        const end = Date.parse(b.finishTime ?? "");
        // A build that was cancelled before it started has no duration. Counting
        // it as a zero-second build would drag Stage 6's trend line down free.
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        out.push({
          // Azure names its pipelines, so unlike GitLab two different pipelines
          // are never averaged together.
          workflow: b.definition?.name ?? "pipeline",
          commit: b.sourceVersion ?? "",
          branch: stripRefsHeads(b.sourceBranch ?? "") || branch,
          durationMs: end - start,
          conclusion: b.result === "succeeded" ? "success" : (b.result ?? "unknown"),
          at: b.finishTime ?? new Date(end).toISOString(),
        });
      }
      return out;
    } catch {
      // Pipelines may not be enabled on the project. Ordinary.
      return [];
    }
  }

  // ── cleanup ────────────────────────────────────────────────────────────────

  /**
   * Cavix's own past review threads, found by the marker.
   *
   * State is always "COMMENTED": Azure has no review object and no bot-blocking
   * vote (see `capabilities`). The workflow only ever acts on
   * CHANGES_REQUESTED, so it correctly finds nothing to dismiss.
   */
  async listOwnReviews(ref: PullRef): Promise<OwnReview[]> {
    try {
      return (await this.listThreads(ref))
        .filter((t) => firstContent(t).includes(REVIEW_MARKER))
        .map((t) => ({ id: t.id ?? 0, state: "COMMENTED" }));
    } catch {
      return [];
    }
  }

  /** Nothing to dismiss: Azure has no blocking bot review. See the file note. */
  async dismissReview(): Promise<void> {
    return;
  }

  /**
   * Our own anchored comments, so a re-review does not stack.
   *
   * A thread is ours when it has a `threadContext` (it is anchored to a file)
   * and its first comment carries the inline marker. The returned id is the
   * THREAD's; `deleteReviewComment` deletes its comment, and Azure removes an
   * empty thread with it.
   */
  async listReviewCommentIds(ref: PullRef): Promise<number[]> {
    try {
      return (await this.listThreads(ref))
        .filter((t) => t.threadContext?.filePath && firstContent(t).includes(INLINE_MARKER))
        .map((t) => t.id ?? 0)
        .filter((id) => id > 0);
    } catch {
      return [];
    }
  }

  async deleteReviewComment(ref: PullRef, threadId: number): Promise<void> {
    try {
      const thread = (await this.listThreads(ref)).find((t) => t.id === threadId);
      const commentId = thread?.comments?.[0]?.id;
      if (!commentId) return;
      await this.json(ref, `${this.prPath(ref)}/threads/${threadId}/comments/${commentId}`, { method: "DELETE" });
    } catch {
      /* already gone is the outcome we wanted */
    }
  }

  // ── the status row ─────────────────────────────────────────────────────────

  /**
   * A pull request status, which a branch policy can require.
   *
   * Azure statuses are append-only: posting the same genre/name again supersedes
   * the previous one rather than editing it, so there is no separate create and
   * update. Returns 0 on refusal, exactly like GitHub, so the workflow's "no
   * status row here" path is the one already proven.
   */
  async createCheckRun(ref: PullRef, input: CheckRunInput): Promise<number> {
    try {
      const res = await this.post<{ id?: number }>(ref, `${this.prPath(ref)}/statuses`, statusPayload(input, this.prUrl(ref)));
      // Azure returns an id; 1 stands in when it does not, because the workflow
      // only ever tests this for truthiness.
      return res?.id ?? 1;
    } catch {
      // A token without vso.code_status, or a project where the policy is off.
      return 0;
    }
  }

  async updateCheckRun(ref: PullRef, checkRunId: number, input: CheckRunInput): Promise<void> {
    if (!checkRunId) return;
    try {
      await this.post(ref, `${this.prPath(ref)}/statuses`, statusPayload(input, input.detailsUrl ?? this.prUrl(ref)));
    } catch {
      /* the review is posted; a stale status row is not worth an error */
    }
  }

  /**
   * Commands are not accepted on Azure DevOps. A refusal, not a stub.
   *
   * Cavix must know a commenter can push before it spends a customer's model
   * budget on their say-so. GitHub sends that in the webhook. GitLab does not,
   * so its client asks the members API, which answers for an arbitrary user with
   * ordinary project scope. Azure has no equivalent: deciding whether some other
   * user may contribute means the Graph API or a Security-namespace ACL read,
   * both of which need organisation-level scopes a review bot should not hold.
   *
   * So this returns false and the edge mints no Azure command job. A command
   * path that cannot check permission is an open door, and this repo has already
   * shipped one of those once.
   */
  async commandsAllowed(): Promise<boolean> {
    return false;
  }

  async whoAmI(): Promise<AuthIdentity> {
    try {
      const probe: PullRef = { owner: "", repo: "", number: 0, headSha: "", installationId: 0 };
      const data = await this.json<{ authenticatedUser?: { providerDisplayName?: string; id?: string } }>(
        probe,
        `${this.root}/_apis/connectionData`,
      );
      const login = data?.authenticatedUser?.providerDisplayName;
      if (login) return { kind: "user", login };
    } catch {
      /* fall through */
    }
    return { kind: "unknown", login: "" };
  }
}

/** Cap on pull requests whose limitations are remembered, so the map is bounded. */
const MAX_TRACKED_REVIEWS = 500;

interface AzureThread {
  id?: number;
  comments?: Array<{ id?: number; content?: string }>;
  threadContext?: { filePath?: string } | null;
}

function firstContent(t: AzureThread): string {
  return t.comments?.[0]?.content ?? "";
}

/** Azure lists folders and merge-conflict entries alongside real file changes. */
function isFileChange(c: AzureChange): boolean {
  if (c.item?.isFolder === true) return false;
  if (c.item?.gitObjectType === "tree") return false;
  if (!c.item?.path) return false;
  // "edit, rename" and friends are real; a bare "none" is a property-only change.
  return (c.changeType ?? "").toLowerCase() !== "none";
}

function pathOf(c: AzureChange): string {
  return stripLeadingSlash(c.item?.path ?? "");
}

/** Azure paths are repository-absolute; the rest of Cavix uses relative ones. */
function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, "");
}

function stripRefsHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** Keep a token out of an error message if one ever reaches a query string. */
function redact(url: string): string {
  return url.replace(/([?&](?:token|api-version)=)[^&]*/gi, "$1***").slice(0, 160);
}

/**
 * A pull request status body.
 *
 * Azure's states are notSet / pending / succeeded / failed / error /
 * notApplicable. There is no neutral, and the same decision as every other
 * platform applies: Cavix being unable to run must never freeze a team's merges,
 * so a run that never happened reports `succeeded` with a description that says
 * plainly that it did not happen.
 */
function statusPayload(input: CheckRunInput, url: string): Record<string, unknown> {
  const state =
    input.status !== "completed" ? "pending" : input.conclusion === "failure" ? "failed" : "succeeded";
  return {
    state,
    description: input.title.slice(0, MAX_STATUS_DESCRIPTION),
    context: { name: STATUS_NAME, genre: STATUS_GENRE },
    targetUrl: url,
  };
}
