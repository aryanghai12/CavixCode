// One review of one pull request, as a state machine.
//
// The bug this exists for: a push during a running review produced TWO reviews,
// seconds apart. The older one was computed against a commit that no longer
// exists, anchored to lines that have moved, and the two raced to write the
// ledger. Whichever landed last won, so the pull request could end up with the
// older review's verdict on top of the newer review's comments.
//
// The edge already collapses a REDELIVERY of one webhook, because its
// idempotency key includes the head SHA. That is a different question. It stops
// the same event producing two jobs; it says nothing about a second, genuinely
// new event arriving while the first job is still running.
//
// Three rules:
//
//   1. At most one review of a pull request is in flight. Enforced here rather
//      than by whoever happens to call, so there is one place to be right.
//   2. A newer head always wins. The older run is marked SUPERSEDED and is
//      expected to notice and stop; if it does not, its post is refused.
//   3. A run that has started POSTING is never interrupted. A pull request with
//      three inline comments and no review body is worse than a late review.

/**
 * Where a review is.
 *
 * `posting` is separate from `running` for rule 3, and `superseded` is separate
 * from `cancelled` because they mean different things to a human reading a log:
 * cancelled is somebody's decision, superseded is the world moving on.
 */
export type RunStatus = "queued" | "running" | "posting" | "completed" | "failed" | "cancelled" | "superseded";

/** The statuses that hold the single-in-flight slot. */
export const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["queued", "running", "posting"]);

export function isActive(status: RunStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export interface ReviewRun {
  runId: string;
  headSha: string;
  baseSha?: string;
  status: RunStatus;
  /** Which worker holds it. For operators reading a log, not for logic. */
  worker?: string;
  startedAt: string;
  /** Last time the holder said it was alive. Drives the stale takeover. */
  updatedAt: string;
  /** Why it ended, when it ended for a reason worth naming. */
  reason?: string;
}

export interface ClaimRequest {
  runId: string;
  headSha: string;
  baseSha?: string;
  worker?: string;
  /**
   * A human asked for this review by name.
   *
   * Coalescing exists for WEBHOOKS: two deliveries of one push, a retry after a
   * slow ACK. It must never apply to somebody typing "@cavixcode review", and
   * the failure it caused was ugly. A run that died with its process kept the
   * slot, so every retry of that commit was turned away as a duplicate, and the
   * person kept asking and kept getting silence. The tool looked broken because
   * from where they were standing it was.
   *
   * A forced claim takes the slot from a run on the same commit. It still will
   * not interrupt a run that has started POSTING, because a half-written review
   * is worse than a late one.
   */
  force?: boolean;
}

/**
 * What a claimant should do.
 *
 * `duplicate` and `wait` are both "do not run now", and they are deliberately
 * different: a duplicate should be dropped forever, while a wait should be
 * retried once the current post finishes.
 */
export type ClaimOutcome =
  | { decision: "claimed"; run: ReviewRun; superseded?: ReviewRun }
  | { decision: "duplicate"; active: ReviewRun }
  | { decision: "wait"; active: ReviewRun };

/**
 * How long a run may go without a heartbeat before another may take it.
 *
 * This is short BECAUSE a live run heartbeats. The holder reports in every
 * `HEARTBEAT_EVERY_MS` for as long as it is working, so silence for several
 * multiples of that means the holder is gone: its process was restarted,
 * redeployed, or killed.
 *
 * It was twenty minutes when there was no heartbeat, and that was the wrong
 * number in both directions. A dead holder wedged the pull request for twenty
 * minutes, during which every retry was refused; and a legitimately slow review
 * that crossed twenty minutes had its slot taken while it was still running.
 * With a heartbeat, both go away.
 */
export const STALE_AFTER_MS = 3 * 60 * 1000;

/**
 * How often a working run should report that it is alive.
 *
 * Comfortably under `STALE_AFTER_MS`, so several heartbeats in a row have to be
 * missed before anybody concludes the holder is gone.
 */
export const HEARTBEAT_EVERY_MS = 30 * 1000;

export interface DecideOptions {
  now?: () => Date;
  staleAfterMs?: number;
}

/**
 * Decide whether a claimant may run, given whatever holds the slot.
 *
 * Pure. The caller applies the result; this only decides, so the rule can be
 * tested without a store, a clock or a network.
 */
export function decideClaim(
  active: ReviewRun | undefined,
  req: ClaimRequest,
  options: DecideOptions = {},
): ClaimOutcome {
  const now = (options.now ?? (() => new Date()))();
  const at = now.toISOString();
  const staleAfter = options.staleAfterMs ?? STALE_AFTER_MS;

  const fresh: ReviewRun = {
    runId: req.runId,
    headSha: req.headSha,
    ...(req.baseSha ? { baseSha: req.baseSha } : {}),
    status: "running",
    ...(req.worker ? { worker: req.worker } : {}),
    startedAt: at,
    updatedAt: at,
  };

  if (!active || !isActive(active.status)) return { decision: "claimed", run: fresh };

  // The holder stopped reporting. Something crashed, or a worker was killed
  // mid-review.
  //
  // Checked FIRST, before the same-commit and mid-post rules, and that order is
  // the whole reason this branch is useful. A dead run holding the slot for its
  // own commit would otherwise make every retry of that commit a "duplicate"
  // forever: the pull request would never be reviewed again, and the symptom is
  // a pull request that silently stops getting reviews with nothing in any log
  // to explain it.
  //
  // Recorded as FAILED rather than superseded. Nothing newer replaced it, it
  // died, and the two read very differently to somebody working out why a
  // review never appeared.
  const age = now.getTime() - Date.parse(active.updatedAt);
  if (Number.isFinite(age) && age > staleAfter) {
    return {
      decision: "claimed",
      run: fresh,
      superseded: { ...active, status: "failed", updatedAt: at, reason: "the worker holding this review stopped reporting" },
    };
  }

  // Mid-post. Never interrupted, whatever has happened upstream, including a
  // human asking by name: a half-written review is worse than a late one. The
  // caller retries once it finishes.
  if (active.status === "posting") return { decision: "wait", active };

  // Same commit, still in flight. Two webhooks for one push, a retry after a
  // slow ACK. Coalesce: running it again would post the same review twice.
  //
  // Unless a human asked. `force` is the difference between "the same event
  // arrived twice" and "somebody is standing there wondering why nothing
  // happened", and treating those the same is what made a stuck run look like a
  // dead product.
  if (active.headSha === req.headSha && !req.force) return { decision: "duplicate", active };

  // Either a newer head, in which case the older run is reviewing a commit
  // nobody will merge, or a human asked again for the same one.
  return {
    decision: "claimed",
    run: fresh,
    superseded: {
      ...active,
      status: "superseded",
      updatedAt: at,
      reason:
        active.headSha === req.headSha
          ? "a person asked for this review again while it was running"
          : `a newer commit (${req.headSha.slice(0, 7)}) was pushed while this review was running`,
    },
  };
}

/**
 * May this run still post?
 *
 * Checked immediately before writing to the pull request. A run that lost its
 * slot must not post: its findings are anchored to a commit that has been
 * replaced, so every line number in them points at whatever has since moved into
 * that position.
 */
export function mayPost(stored: ReviewRun | undefined, runId: string): boolean {
  // Nothing recorded means run tracking is not enabled on this deployment, which
  // is the behaviour every deployment had before this existed. It must not be
  // read as "you were cancelled".
  if (!stored) return true;
  if (stored.runId !== runId) return false;
  return isActive(stored.status);
}

/** Move a run into `posting`, the state nothing may interrupt. */
export function beginPosting(run: ReviewRun, at = new Date().toISOString()): ReviewRun {
  return { ...run, status: "posting", updatedAt: at };
}

/** Finish a run, one way or another. */
export function finishRun(
  run: ReviewRun,
  status: Extract<RunStatus, "completed" | "failed" | "cancelled">,
  reason?: string,
  at = new Date().toISOString(),
): ReviewRun {
  return { ...run, status, updatedAt: at, ...(reason ? { reason } : {}) };
}

/** Narrow an untrusted run record off the wire. */
export function coerceRun(value: unknown): ReviewRun | undefined {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const runId = typeof v.runId === "string" ? v.runId : "";
  const headSha = typeof v.headSha === "string" ? v.headSha : "";
  if (!runId || !headSha) return undefined;
  const status = isRunStatus(v.status) ? v.status : "running";
  const startedAt = typeof v.startedAt === "string" ? v.startedAt : new Date(0).toISOString();
  return {
    runId,
    headSha,
    ...(typeof v.baseSha === "string" && v.baseSha ? { baseSha: v.baseSha } : {}),
    status,
    ...(typeof v.worker === "string" && v.worker ? { worker: v.worker } : {}),
    startedAt,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : startedAt,
    ...(typeof v.reason === "string" && v.reason ? { reason: v.reason } : {}),
  };
}

function isRunStatus(v: unknown): v is RunStatus {
  return (
    v === "queued" ||
    v === "running" ||
    v === "posting" ||
    v === "completed" ||
    v === "failed" ||
    v === "cancelled" ||
    v === "superseded"
  );
}
