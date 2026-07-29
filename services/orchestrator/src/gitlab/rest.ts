import {
  INLINE_MARKER,
  REVIEW_MARKER,
  type AuthIdentity,
  type CheckRunInput,
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

// GitLab, as the second live platform. Merge requests instead of pull requests,
// notes and discussions instead of reviews, and one API (v4) that gitlab.com and
// every self-managed CE/EE install share, which is why this is the platform that
// proves the seam: no second dialect, and `baseUrl` is the whole of self-hosting.
//
// WHAT GITLAB CANNOT DO, stated here once so nothing downstream has to guess:
//
//   • There is no review object. A GitHub review is one submission carrying a
//     body and N inline comments, posted atomically. GitLab has a NOTE (a plain
//     comment) and a DISCUSSION (a comment anchored to a diff position), created
//     one request at a time. So `postReview` is a summary note followed by a
//     discussion per finding, and a failure partway through leaves the summary
//     posted and some findings missing rather than nothing at all. That is the
//     better half of a bad trade: the summary names every finding anyway.
//
//   • There is no CHANGES_REQUESTED, and therefore nothing to dismiss. A bot
//     cannot hold GitLab's merge button the way it can GitHub's. Blocking is
//     expressed as a FAILED COMMIT STATUS instead, which an org can make
//     required, and `capabilities.blockingReview` is false so the review says
//     plainly that Cavix is not standing in front of the merge here.
//
//   • Discussion positions need base, start and head SHAs together. GitHub takes
//     a path and a line. An inline comment whose position GitLab rejects is
//     dropped and counted, never retried as a top-level comment, because a
//     "finding" that lost its line is noise in the conversation.
//
// Everything here is written against the same ReviewPlatform port as GitHub, so
// the workflow does not branch on platform anywhere.

/** GitLab's answer to a check run: a commit status in the pipeline widget. */
const STATUS_NAME = "Cavix Review";

export const GITLAB_CAPABILITIES: PlatformCapabilities = {
  // A commit status, not a check run. It shows in the MR's pipeline widget and
  // an org can require it, which is the part that matters.
  checkRuns: true,
  // Award emoji on a note. The same acknowledgment, the same meaning.
  reactions: true,
  // No bot-blocking review exists. See the note above.
  blockingReview: false,
  deleteInlineComments: true,
  treeListing: true,
  // Pipelines, which is the direct equivalent of Actions runs.
  ciHistory: true,
};

export interface GitLabTokenProvider {
  /** A token for this workspace. GitLab has no per-install token to mint. */
  token(org: string): Promise<string>;
}

export class StaticGitLabToken implements GitLabTokenProvider {
  private readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  async token(): Promise<string> {
    if (!this.value) throw new Error("gitlab: token is empty");
    return this.value;
  }
}

export interface RestGitLabOptions {
  tokens: GitLabTokenProvider;
  /** Self-managed instance root, e.g. https://gitlab.example.com. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * The three SHAs a discussion position needs, keyed by merge request and head.
 *
 * `/merge_requests/:iid/changes` already returns them, and the review path
 * always fetches the diff before it posts, so caching them there saves a whole
 * extra round trip per review. Keyed on the head SHA so a new push invalidates
 * it: posting a discussion against a stale position is precisely what GitLab
 * rejects, and silently anchoring to the wrong commit would be worse than the
 * rejection.
 */
interface DiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

/** GitLab reports "opened" | "closed" | "merged"; the workflow speaks GitHub's. */
function toPullState(s: string | undefined): string {
  return s === "opened" ? "open" : (s ?? "open");
}

export class RestGitLabClient implements ReviewPlatform {
  readonly platform = "gitlab" as const;
  readonly capabilities = GITLAB_CAPABILITIES;

  private readonly tokens: GitLabTokenProvider;
  private readonly root: string;
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: { info(msg: string, meta?: Record<string, unknown>): void };
  /**
   * Diff refs seen on the way past, keyed by project/iid/head.
   *
   * Keyed rather than a single field, because ONE client instance serves every
   * review this orchestrator runs, concurrently. A bare instance field would be
   * overwritten by whichever merge request happened to be fetched last, and the
   * review that read it would anchor its findings to another project's commits.
   */
  private readonly diffRefs = new Map<string, DiffRefs>();

  constructor(opts: RestGitLabOptions) {
    this.tokens = opts.tokens;
    this.root = (opts.baseUrl ?? "https://gitlab.com").replace(/\/$/, "");
    this.api = `${this.root}/api/v4`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger;
  }

  private refsKey(ref: PullRef): string {
    return `${this.project(ref)}!${ref.number}@${ref.headSha}`;
  }

  /**
   * A project id GitLab will accept in a path.
   *
   * The full path has to be URL-encoded WHOLE, slashes and all, which is what
   * makes nested groups work: "acme/platform/billing" becomes
   * "acme%2Fplatform%2Fbilling". Encoding the segments separately gives a path
   * GitLab reads as three levels of nothing and answers 404.
   */
  private project(ref: PullRef): string {
    return encodeURIComponent(ref.owner ? `${ref.owner}/${ref.repo}` : ref.repo);
  }

  private async headers(ref: PullRef): Promise<Record<string, string>> {
    return {
      // PRIVATE-TOKEN accepts a personal, project or group access token. Bearer
      // would only accept an OAuth token, which a self-managed admin is far less
      // likely to be able to issue.
      "private-token": await this.tokens.token(ref.owner),
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
      throw new Error(`gitlab: ${init.method ?? "GET"} ${path} HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private async post<T>(ref: PullRef, path: string, body: unknown): Promise<T | null> {
    return this.json<T>(ref, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private mrUrl(ref: PullRef): string {
    return `${this.root}/${ref.owner}/${ref.repo}/-/merge_requests/${ref.number}`;
  }

  // ── the diff ───────────────────────────────────────────────────────────────

  /**
   * A unified diff, assembled from GitLab's per-file change objects.
   *
   * GitLab has no "give me the whole thing as a diff" media type the way GitHub
   * does, so the `diff` field of each change (which is a real unified hunk set)
   * is prefixed with the `diff --git` and `---`/`+++` headers the rest of Cavix
   * parses. Without those headers `parseUnifiedDiff` sees one anonymous blob and
   * every finding loses its file.
   */
  async fetchPullDiff(ref: PullRef): Promise<string> {
    const body = await this.json<{
      changes?: Array<{ old_path?: string; new_path?: string; diff?: string; deleted_file?: boolean }>;
      diff_refs?: Partial<DiffRefs>;
    }>(ref, `/projects/${this.project(ref)}/merge_requests/${ref.number}/changes`);
    if (!body) throw new Error(`gitlab: merge request ${ref.owner}/${ref.repo}!${ref.number} not found`);

    // This response already carries what a discussion position needs, so keep
    // it: posting the review would otherwise re-fetch the merge request it just
    // read, once per review, for three strings.
    const r = body.diff_refs;
    if (r?.base_sha && r.head_sha && r.start_sha) {
      this.diffRefs.set(this.refsKey(ref), { base_sha: r.base_sha, head_sha: r.head_sha, start_sha: r.start_sha });
    }

    const out: string[] = [];
    for (const c of body.changes ?? []) {
      const newPath = c.new_path ?? c.old_path ?? "";
      const oldPath = c.old_path ?? newPath;
      if (!c.diff || !newPath) continue;
      out.push(`diff --git a/${oldPath} b/${newPath}`);
      out.push(`--- ${c.deleted_file ? "/dev/null" : `a/${oldPath}`}`);
      out.push(`+++ b/${newPath}`);
      out.push(c.diff.replace(/\n$/, ""));
    }
    return out.length > 0 ? `${out.join("\n")}\n` : "";
  }

  async getPull(ref: PullRef): Promise<PullMeta> {
    const mr = await this.json<{
      title?: string;
      description?: string | null;
      state?: string;
      draft?: boolean;
      work_in_progress?: boolean;
      sha?: string;
      target_branch?: string;
      diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string };
    }>(ref, `/projects/${this.project(ref)}/merge_requests/${ref.number}`);
    if (!mr) throw new Error(`gitlab: merge request ${ref.owner}/${ref.repo}!${ref.number} not found`);
    return {
      headSha: mr.diff_refs?.head_sha ?? mr.sha ?? "",
      baseSha: mr.diff_refs?.base_sha ?? "",
      baseRef: mr.target_branch || "main",
      title: mr.title ?? "",
      // `draft` is the modern field; `work_in_progress` is what older
      // self-managed instances still send, and a lot of them are old.
      draft: mr.draft === true || mr.work_in_progress === true,
      state: toPullState(mr.state),
      body: mr.description ?? "",
    };
  }

  async fetchFile(ref: PullRef, path: string, sha?: string): Promise<string | null> {
    const commit = sha ?? ref.headSha;
    if (!commit) return null;
    const file = await this.json<{ content?: string; encoding?: string }>(
      ref,
      `/projects/${this.project(ref)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(commit)}`,
    );
    if (!file || typeof file.content !== "string" || file.encoding !== "base64") return null;
    return Buffer.from(file.content, "base64").toString("utf8");
  }

  async updatePullBody(ref: PullRef, body: string): Promise<void> {
    await this.json(ref, `/projects/${this.project(ref)}/merge_requests/${ref.number}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: body }),
    });
  }

  // ── the review ─────────────────────────────────────────────────────────────

  /**
   * A summary note, then one discussion per inline comment.
   *
   * The summary goes FIRST and its failure is the only fatal one here. Every
   * finding is named in the summary body, so a review that posts the summary and
   * loses three inline anchors is still a complete review with three fewer
   * conveniences. A review that posts three inline comments and no summary is a
   * scattering of remarks with no verdict, which is worse than nothing.
   */
  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    const project = this.project(ref);
    const note = await this.post<{ id?: number }>(ref, `/projects/${project}/merge_requests/${ref.number}/notes`, {
      body: review.body,
    });
    if (!note) throw new Error(`gitlab: could not post the review note on !${ref.number}`);

    // Positions need all three SHAs together, and GitLab rejects the discussion
    // outright if they disagree with the merge request's current diff. Normally
    // already cached by fetchPullDiff; fetched here only if something posted a
    // review without reading the diff first.
    let refs = this.diffRefs.get(this.refsKey(ref));
    if (!refs) {
      const meta = await this.json<{ diff_refs?: Partial<DiffRefs> }>(
        ref,
        `/projects/${project}/merge_requests/${ref.number}`,
      );
      const r = meta?.diff_refs;
      if (r?.base_sha && r.head_sha && r.start_sha) {
        refs = { base_sha: r.base_sha, head_sha: r.head_sha, start_sha: r.start_sha };
      }
    }

    let posted = 0;
    if (refs) {
      for (const c of review.comments) {
        try {
          await this.post(ref, `/projects/${project}/merge_requests/${ref.number}/discussions`, {
            body: c.body,
            position: {
              position_type: "text",
              new_path: c.path,
              old_path: c.path,
              new_line: c.line,
              base_sha: refs.base_sha,
              head_sha: refs.head_sha,
              start_sha: refs.start_sha,
            },
          });
          posted++;
        } catch {
          // An anchor GitLab will not accept (the line moved, the file is
          // binary, the diff is stale). The finding is already in the summary
          // body, so this costs a convenience and never the finding itself.
        }
      }
    }

    if (posted < review.comments.length) {
      // Reported, not stored. A count on the instance would be shared by every
      // review this orchestrator runs at once and would name the wrong one.
      this.logger?.info("gitlab refused some inline anchors; the findings are still in the summary", {
        repo: `${ref.owner}/${ref.repo}`,
        mr: ref.number,
        wanted: review.comments.length,
        anchored: posted,
      });
    }
    return { id: note.id ?? 0, htmlUrl: this.mrUrl(ref) };
  }

  // ── conversation ───────────────────────────────────────────────────────────

  async addReaction(ref: PullRef, commentId: number, content: ReactionContent): Promise<void> {
    const name = AWARD_EMOJI[content];
    if (!name) return;
    // GitLab 404s an award on a note that is not ours to award, and 409s a
    // duplicate. Neither is worth failing over: this is an acknowledgment.
    try {
      await this.post(ref, `/projects/${this.project(ref)}/merge_requests/${ref.number}/notes/${commentId}/award_emoji`, {
        name,
      });
    } catch {
      /* best effort, exactly as on GitHub */
    }
  }

  async createComment(ref: PullRef, body: string): Promise<{ id: number; htmlUrl: string }> {
    const note = await this.post<{ id?: number }>(
      ref,
      `/projects/${this.project(ref)}/merge_requests/${ref.number}/notes`,
      { body },
    );
    return { id: note?.id ?? 0, htmlUrl: this.mrUrl(ref) };
  }

  async findComment(ref: PullRef, marker: string): Promise<{ id: number } | null> {
    const notes = await this.json<Array<{ id: number; body?: string }>>(
      ref,
      `/projects/${this.project(ref)}/merge_requests/${ref.number}/notes?per_page=100&sort=desc`,
    );
    const found = (notes ?? []).find((n) => (n.body ?? "").includes(marker));
    return found ? { id: found.id } : null;
  }

  async updateComment(ref: PullRef, commentId: number, body: string): Promise<void> {
    await this.json(ref, `/projects/${this.project(ref)}/merge_requests/${ref.number}/notes/${commentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }

  // ── repository ─────────────────────────────────────────────────────────────

  /**
   * Every blob path at a commit.
   *
   * Paginated at 100, unlike GitHub's single recursive tree call, so this walks
   * pages until the repository runs out or the cap is hit. The cap is the point:
   * this runs on somebody else's rate limit and a monorepo would otherwise spend
   * a hundred requests here before a review is posted.
   */
  async listTree(ref: PullRef, sha?: string): Promise<string[]> {
    const commit = sha ?? ref.headSha;
    if (!commit) return [];
    const out: string[] = [];
    try {
      for (let page = 1; page <= MAX_TREE_PAGES; page++) {
        const rows = await this.json<Array<{ path?: string; type?: string }>>(
          ref,
          `/projects/${this.project(ref)}/repository/tree?recursive=true&per_page=100&page=${page}` +
            `&ref=${encodeURIComponent(commit)}`,
        );
        if (!rows || rows.length === 0) break;
        for (const r of rows) if (r.type === "blob" && r.path) out.push(r.path);
        if (rows.length < 100) break;
      }
    } catch {
      // A partial map is worth having and a missing one must never fail a review.
    }
    return out;
  }

  /**
   * Completed pipelines on a branch, as Stage 6's run history.
   *
   * The list endpoint does not carry durations, so each pipeline needs its own
   * call. That is why the default limit here is smaller than GitHub's: sixty
   * pipelines would be sixty-one requests on a customer's rate limit, for a
   * trend line. Twenty is enough to see one.
   */
  async listWorkflowRuns(ref: PullRef, branch: string, limit = 20): Promise<WorkflowRun[]> {
    const project = this.project(ref);
    let list: Array<{ id?: number }> | null = null;
    try {
      list = await this.json<Array<{ id?: number }>>(
        ref,
        `/projects/${project}/pipelines?scope=finished&per_page=${Math.min(50, limit)}` +
          `&ref=${encodeURIComponent(branch)}`,
      );
    } catch {
      return [];
    }
    const out: WorkflowRun[] = [];
    for (const p of (list ?? []).slice(0, limit)) {
      if (!p.id) continue;
      try {
        const full = await this.json<{
          sha?: string;
          ref?: string;
          status?: string;
          duration?: number;
          started_at?: string;
          finished_at?: string;
        }>(ref, `/projects/${project}/pipelines/${p.id}`);
        if (!full) continue;
        // `duration` is seconds of running time and is null on a pipeline that
        // never started. Fall back to the wall clock, and skip anything that
        // yields neither rather than reporting a zero-length build.
        const started = Date.parse(full.started_at ?? "");
        const finished = Date.parse(full.finished_at ?? "");
        const durationMs =
          typeof full.duration === "number" && full.duration > 0
            ? full.duration * 1000
            : Number.isFinite(started) && Number.isFinite(finished) && finished > started
              ? finished - started
              : 0;
        if (durationMs <= 0) continue;
        out.push({
          // GitLab has one pipeline per project rather than named workflows, so
          // every run belongs to the same series. Naming it "pipeline" keeps
          // Stage 6 from averaging two things that are not comparable, because
          // on GitLab there is only ever one thing.
          workflow: "pipeline",
          commit: full.sha ?? "",
          branch: full.ref ?? branch,
          durationMs,
          conclusion: full.status === "success" ? "success" : (full.status ?? "unknown"),
          at: full.finished_at ?? new Date().toISOString(),
        });
      } catch {
        /* one unreadable pipeline is not a reason to lose the other nineteen */
      }
    }
    return out;
  }

  // ── cleanup ────────────────────────────────────────────────────────────────

  /**
   * Cavix's own past review notes, found by the hidden marker.
   *
   * They are notes, not reviews, so `state` is always "COMMENTED": GitLab has no
   * review states. The workflow only ever looks for CHANGES_REQUESTED here, so
   * it correctly finds nothing to dismiss.
   */
  async listOwnReviews(ref: PullRef): Promise<OwnReview[]> {
    try {
      const notes = await this.json<Array<{ id: number; body?: string }>>(
        ref,
        `/projects/${this.project(ref)}/merge_requests/${ref.number}/notes?per_page=100`,
      );
      return (notes ?? [])
        .filter((n) => (n.body ?? "").includes(REVIEW_MARKER))
        .map((n) => ({ id: n.id, state: "COMMENTED" }));
    } catch {
      return [];
    }
  }

  /** Nothing to dismiss: GitLab has no blocking bot review. See the file note. */
  async dismissReview(): Promise<void> {
    return;
  }

  /**
   * Inline comment ids to delete.
   *
   * GitLab does not tie a discussion note back to a "review" the way GitHub
   * does, because there is no review. Our own inline notes are found the same
   * way our summary is: by the marker the poster puts in every body.
   */
  async listReviewCommentIds(ref: PullRef): Promise<number[]> {
    try {
      const discussions = await this.json<
        Array<{ notes?: Array<{ id: number; body?: string; type?: string | null }> }>
      >(ref, `/projects/${this.project(ref)}/merge_requests/${ref.number}/discussions?per_page=100`);
      const ids: number[] = [];
      for (const d of discussions ?? []) {
        for (const n of d.notes ?? []) {
          // DiffNote is the anchored kind. A plain note here is the summary,
          // which is deliberately left alone: GitHub cannot delete its review
          // bodies either, and the two platforms should not disagree about what
          // a re-review clears.
          if (n.type === "DiffNote" && (n.body ?? "").includes(INLINE_MARKER)) ids.push(n.id);
        }
      }
      return ids;
    } catch {
      return [];
    }
  }

  async deleteReviewComment(ref: PullRef, commentId: number): Promise<void> {
    try {
      await this.json(ref, `/projects/${this.project(ref)}/merge_requests/${ref.number}/notes/${commentId}`, {
        method: "DELETE",
      });
    } catch {
      // Already gone is the outcome we wanted.
    }
  }

  // ── the status row ─────────────────────────────────────────────────────────

  /**
   * GitLab's answer to a check run: a commit status.
   *
   * There is no separate create and update. Posting the same `name` against the
   * same commit again moves the existing status on, so `createCheckRun` returns
   * the commit it is anchored to (as a number GitLab never uses) and
   * `updateCheckRun` posts again. Returns 0 on refusal, exactly like GitHub, so
   * the workflow's "no status row here" path is the one already proven.
   */
  async createCheckRun(ref: PullRef, input: CheckRunInput): Promise<number> {
    if (!ref.headSha) return 0;
    try {
      const res = await this.post<{ id?: number }>(
        ref,
        `/projects/${this.project(ref)}/statuses/${encodeURIComponent(ref.headSha)}`,
        statusPayload(input),
      );
      return res?.id ?? 0;
    } catch {
      // A token without `api` scope, or a commit that is not in this project.
      // Both are ordinary and neither costs the review.
      return 0;
    }
  }

  async updateCheckRun(ref: PullRef, checkRunId: number, input: CheckRunInput): Promise<void> {
    if (!checkRunId || !ref.headSha) return;
    try {
      await this.post(ref, `/projects/${this.project(ref)}/statuses/${encodeURIComponent(ref.headSha)}`, statusPayload(input));
    } catch {
      /* the review is already posted; a stale status row is not worth an error */
    }
  }

  /**
   * Can this user push to the project?
   *
   * This is the check the edge cannot make. GitLab's note webhook says who
   * commented and nothing about what they are allowed to do, so without asking
   * here, any account that can see a public merge request could type
   * "@cavixcode review" repeatedly and spend a customer's model budget.
   *
   * `members/all` rather than `members`, because it includes membership
   * inherited from a parent group, which is how most GitLab organisations
   * actually grant access. Access level 30 is Developer, the lowest that can
   * push; Reporter (20) and Guest (10) cannot, and neither should be able to
   * make Cavix act on the branch.
   *
   * Fails CLOSED. A lookup that errors returns false, because the alternative is
   * an outage of GitLab's members API turning into an open door.
   */
  async commandsAllowed(ref: PullRef, username: string): Promise<boolean> {
    if (!username) return false;
    try {
      const members = await this.json<Array<{ username?: string; access_level?: number; state?: string }>>(
        ref,
        `/projects/${this.project(ref)}/members/all?query=${encodeURIComponent(username)}&per_page=100`,
      );
      const wanted = username.toLowerCase();
      return (members ?? []).some(
        (m) =>
          (m.username ?? "").toLowerCase() === wanted &&
          m.state !== "blocked" &&
          typeof m.access_level === "number" &&
          m.access_level >= GITLAB_DEVELOPER,
      );
    } catch (err) {
      this.logger?.info("could not check gitlab project membership; refusing the command", {
        repo: `${ref.owner}/${ref.repo}`,
        user: username,
        err: (err as Error).message,
      });
      return false;
    }
  }

  async whoAmI(): Promise<AuthIdentity> {
    try {
      const probe: PullRef = { owner: "", repo: "", number: 0, headSha: "", installationId: 0 };
      const me = await this.json<{ username?: string; bot?: boolean }>(probe, "/user");
      if (me?.username) return { kind: me.bot ? "app" : "user", login: me.username };
    } catch {
      /* fall through */
    }
    return { kind: "unknown", login: "" };
  }
}

/** Pages of 100 paths. Beyond this a monorepo is spending a review's latency. */
const MAX_TREE_PAGES = 10;

/** GitLab's Developer access level: the lowest that can push to a branch. */
const GITLAB_DEVELOPER = 30;

/**
 * GitHub reaction names to GitLab award emoji names.
 *
 * The two vocabularies overlap but do not match: GitHub's "+1" is GitLab's
 * "thumbsup", and GitHub's "confused" has no GitLab equivalent at all, so it
 * maps to the nearest honest thing rather than being silently dropped.
 */
const AWARD_EMOJI: Record<ReactionContent, string> = {
  "+1": "thumbsup",
  "-1": "thumbsdown",
  laugh: "laughing",
  confused: "confused",
  heart: "heart",
  hooray: "tada",
  rocket: "rocket",
  eyes: "eyes",
};

/**
 * A commit status body.
 *
 * GitLab's states are a different set from GitHub's conclusions: there is no
 * "neutral", and the closest thing to "Cavix could not run" is `success` with a
 * description that says so. That is the same decision the GitHub path already
 * makes for its own reasons: an outage of ours must never freeze a team's
 * merges, so a run that never happened never blocks anyone.
 */
function statusPayload(input: CheckRunInput): Record<string, unknown> {
  const state =
    input.status !== "completed"
      ? "running"
      : input.conclusion === "failure"
        ? "failed"
        : "success";
  return {
    state,
    name: STATUS_NAME,
    // GitLab caps this at 255 and rejects the whole request when it is longer.
    description: input.title.slice(0, 255),
    ...(input.detailsUrl ? { target_url: input.detailsUrl } : {}),
  };
}
