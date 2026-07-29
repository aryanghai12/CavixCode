// ReviewJob mirrors the canonical schema the Go edge emits onto the Redis
// Stream. Field names are snake_case to match the edge's JSON byte-for-byte —
// this is the single wire contract between Stage 0 and Stage 1. If the edge's
// canonical.SchemaVersion changes, SCHEMA_VERSION here must move in lockstep.
export const SCHEMA_VERSION = "1";

export interface ReviewJob {
  schema_version: string;
  /**
   * Which code host this job came from: "github" or "gitlab".
   *
   * Optional, and absent means GitHub. That is deliberate rather than lazy: jobs
   * already sitting on the Redis Stream when a new orchestrator starts predate
   * the field, and requiring it would have turned every one of them into a
   * poison message on the deploy that introduced a second platform. It is also
   * why the schema version did not move.
   */
  platform?: string;
  idempotency_key: string;
  delivery_id: string;
  org: string;
  repo: string; // "owner/name"
  repo_id: number;
  pr_number: number;
  action: string;
  /**
   * Commit to review. EMPTY for command jobs ("@cavixcode review"): an
   * issue_comment payload carries no commit, so the orchestrator resolves the
   * PR's current head from the API before posting.
   */
  head_sha: string;
  base_sha: string;
  installation_id: number;
  priority: number;
  title: string;
  author: string;
  enqueued_at: string;

  /** Why this job exists: "pull_request" (automatic) or "command" (a human mention). */
  trigger?: string;
  /** Set only when trigger === "command". */
  command?: string;
  command_args?: string;
  /** The comment that issued the command — what we react to and reply under. */
  comment_id?: number;
  author_association?: string;
  /** "@cavixcode review" → discard caches and stale bot reviews. */
  force_fresh?: boolean;
}

/** Trigger values the edge emits. */
export const TRIGGER_PULL_REQUEST = "pull_request";
export const TRIGGER_COMMAND = "command";

/** True when the job came from a human typing "@cavixcode <command>" on a PR. */
export function isCommandJob(job: ReviewJob): boolean {
  return job.trigger === TRIGGER_COMMAND;
}

/** Code hosts the edge can produce jobs for. */
export const PLATFORM_GITHUB = "github";
export const PLATFORM_GITLAB = "gitlab";

/**
 * Which platform a job belongs to, defaulting to GitHub.
 *
 * One function rather than `job.platform ?? "github"` scattered around, because
 * the default is a compatibility decision (see `ReviewJob.platform`) and the
 * next person to add a platform needs to find every place that assumed one.
 */
export function platformOf(job: ReviewJob): string {
  const p = (job.platform ?? "").trim().toLowerCase();
  return p === "" ? PLATFORM_GITHUB : p;
}

/**
 * parseReviewJob validates and narrows an untrusted JSON value (read off the
 * stream) into a ReviewJob. We assert the schema version and the few fields the
 * orchestrator cannot proceed without, failing loud on skew or corruption
 * rather than letting undefined values flow into the workflow.
 */
export function parseReviewJob(value: unknown): ReviewJob {
  if (typeof value !== "object" || value === null) {
    throw new Error("review job is not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `review job schema mismatch: got ${String(v.schema_version)}, want ${SCHEMA_VERSION}`,
    );
  }
  if (typeof v.repo !== "string" || v.repo === "") {
    throw new Error("review job missing required field: repo");
  }
  // head_sha is required for pull_request jobs (the event always carries it) but
  // NOT for command jobs — an issue_comment payload has no commit, so the
  // orchestrator resolves the PR head itself. Requiring it here used to drop
  // every "@cavixcode review" as a poison message.
  if (v.trigger !== TRIGGER_COMMAND) {
    if (typeof v.head_sha !== "string" || v.head_sha === "") {
      throw new Error("review job missing required field: head_sha");
    }
  }
  if (typeof v.pr_number !== "number" || v.pr_number <= 0) {
    throw new Error("review job missing required field: pr_number");
  }
  return v as unknown as ReviewJob;
}
