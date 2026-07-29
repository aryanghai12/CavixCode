import type { PurgeCheck, PurgeStatus } from "./purge.ts";

// The artefact a regulated buyer's auditor actually asks for.
//
// WHAT IT IS, and why it is not a boolean. "Zero retention: yes" on a dashboard
// row is a claim, and a security review will ask what backs it. So this names,
// per sandbox the review provisioned, which backend ran it, what was checked,
// and what came back. A reader who does not trust us can evaluate the sentence
// in `check` on its own terms and decide whether it proves what we say it does.
//
// WHAT IT DELIBERATELY DOES NOT CONTAIN. No paths, no file names, no code, no
// finding text, no commit. A retention proof that carries a filesystem path from
// the machine that reviewed a customer's private repository is itself a
// retention problem, and it is the kind that survives in a database for years
// because nobody thought of it as data. Everything here is a count, a backend
// name, a status, or a sentence written by Cavix.
//
// The review id and the workspace are the only identifiers, and they have to be:
// an auditor asking about a review from four months ago has nothing else to ask
// with. Neither says anything about the code.

export interface RetentionAttestation {
  /**
   * The review this covers, where one is known.
   *
   * OPTIONAL, and absent on the wire from the orchestrator, which is not an
   * oversight: the control-plane assigns a review id when it stores the record,
   * so the orchestrator's only candidate would be something like
   * "owner/repo#12@sha" and that puts a repository name inside the artefact
   * whose whole purpose is to carry nothing about the customer's code. The
   * record this hangs on identifies the review already.
   */
  reviewId?: string;
  /** Dashboard workspace. Not the repository, which would name the code. */
  org: string;
  /** ISO 8601, when the last sandbox for this review was torn down. */
  at: string;
  /** Sandboxes this review provisioned. Zero is an ordinary outcome. */
  sandboxes: number;
  /** One per sandbox, in teardown order. */
  checks: PurgeCheck[];
  /**
   * The overall reading, derived and never set by hand:
   *   proven        every sandbox was checked and every check passed
   *   unverified    nothing was provisioned, or no check could run
   *   partial       some sandboxes were checked, some could not be
   *   violated      a check found something still there
   */
  verdict: RetentionVerdict;
}

export type RetentionVerdict = "proven" | "partial" | "unverified" | "violated";

/**
 * Fold per-sandbox checks into one honest verdict.
 *
 * `violated` wins over everything, because a single surviving workspace is the
 * fact that matters and averaging it away would be the exact dishonesty this
 * artefact exists to prevent. `partial` exists so a deployment running a mix of
 * backends is not rounded up to "proven" or down to "unverified": both would be
 * false, and the second would hide real evidence.
 */
export function verdictOf(checks: PurgeCheck[]): RetentionVerdict {
  if (checks.length === 0) return "unverified";
  if (checks.some((c) => c.status === "residual")) return "violated";
  const purged = checks.filter((c) => c.status === "purged").length;
  if (purged === checks.length) return "proven";
  if (purged === 0) return "unverified";
  return "partial";
}

export function buildAttestation(input: {
  reviewId?: string;
  org: string;
  checks: PurgeCheck[];
  at?: string;
}): RetentionAttestation {
  return {
    ...(input.reviewId ? { reviewId: input.reviewId } : {}),
    org: input.org,
    at: input.at ?? new Date().toISOString(),
    sandboxes: input.checks.length,
    checks: input.checks,
    verdict: verdictOf(input.checks),
  };
}

/**
 * One sentence a non-engineer can act on, for the dashboard.
 *
 * Deliberately says what was measured rather than reassuring. "No customer code
 * was retained" is the claim; "3 of 3 sandboxes were checked and each was gone"
 * is the evidence, and only the second one survives an auditor asking how we
 * know.
 */
export function explainAttestation(a: RetentionAttestation): string {
  const n = a.sandboxes;
  const purged = a.checks.filter((c) => c.status === "purged").length;
  switch (a.verdict) {
    case "proven":
      return `${purged} of ${n} sandbox${n === 1 ? "" : "es"} verified destroyed after this review. No customer code remains.`;
    case "partial":
      return `${purged} of ${n} sandboxes verified destroyed. The rest ran on a backend this deployment cannot inspect after teardown, so their destruction rests on the backend's contract rather than on a check.`;
    case "unverified":
      return n === 0
        ? "No sandbox was provisioned for this review, so no customer code was ever written to one."
        : `${n} sandbox${n === 1 ? "" : "es"} ran on a backend this deployment cannot inspect after teardown. Destruction rests on the backend's contract rather than on a check.`;
    case "violated":
      return `A sandbox workspace survived teardown on this review. This is a retention violation and has been recorded for investigation.`;
  }
}

/** Statuses in the order a reader should worry about them. */
export const PURGE_STATUS_ORDER: PurgeStatus[] = ["residual", "unverifiable", "purged"];
