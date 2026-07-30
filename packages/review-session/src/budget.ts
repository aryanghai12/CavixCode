// The per-pull-request review budget.
//
// Before this, the only limit on Cavix was the workspace's reviews-per-DAY. That
// is the wrong unit for the thing that actually runs away: a single pull request
// with thirty pushes is thirty reviews, and on a free workspace with a 25/day
// allowance that one pull request has spent everybody else's day by lunchtime.
// The customer's experience of that is not "we hit a limit", it is "Cavix
// stopped working", on repositories that were nowhere near the pull request that
// spent it.
//
// So the budget is counted per pull request as well, and the two limits are
// different promises:
//
//   free   a fixed number, the same for every workspace on the tier, and NOT
//          raisable. That is the tier boundary. A free limit a maintainer could
//          raise is not a limit, and quietly letting one be raised is how a free
//          tier stops being free to run.
//   paid   a higher default that the maintainer owns and can change from
//          Review settings, because on a paid workspace the cost is theirs and
//          the judgement should be too.
//
// Reaching the cap never changes a VERDICT. It stops Cavix reviewing, and the
// check keeps whatever the last review concluded. Running out of budget must not
// be a way to turn a red check green: that would make the limit a bypass.

export type Tier = "free" | "paid";

/** Reviews one pull request gets on the free tier. Fixed, and not raisable. */
export const FREE_REVIEWS_PER_PR = 10;

/** The paid default. A maintainer can move this, up or down, per workspace. */
export const PAID_REVIEWS_PER_PR = 50;

/** Bounds on what a maintainer may set. Below 1 would switch Cavix off by arithmetic. */
export const MIN_REVIEWS_PER_PR = 1;
export const MAX_REVIEWS_PER_PR = 1000;

export interface BudgetInput {
  tier: Tier;
  /** Reviews already posted on this pull request. */
  used: number;
  /** The maintainer's setting, when they have made one. Ignored on free. */
  override?: number;
  /**
   * Deployment-level defaults, from the environment. Absent means the constants
   * above, which are what a deployment that has configured nothing gets.
   */
  freeDefault?: number;
  paidDefault?: number;
}

export interface Budget {
  used: number;
  limit: number;
  remaining: number;
  tier: Tier;
  /** Has this pull request spent its allowance? */
  exhausted: boolean;
  /**
   * May a maintainer raise this limit?
   *
   * False on free, and that is the whole point of the field: the dashboard reads
   * it to render the control as locked with the reason, rather than offering an
   * input that silently refuses to save.
   */
  raisable: boolean;
}

/**
 * What is left for this pull request.
 *
 * The override is consulted only on paid. Not "clamped on free", IGNORED on
 * free: a workspace that was paid, set an override of 500, and then downgraded
 * must land back on the free limit rather than keeping the number it bought.
 */
export function reviewBudget(input: BudgetInput): Budget {
  const used = Math.max(0, Math.floor(input.used));
  const limit =
    input.tier === "free"
      ? positive(input.freeDefault, FREE_REVIEWS_PER_PR)
      : clampLimit(input.override ?? positive(input.paidDefault, PAID_REVIEWS_PER_PR));
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    tier: input.tier,
    exhausted: used >= limit,
    raisable: input.tier !== "free",
  };
}

/** Hold a maintainer's number inside the bounds. */
export function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return PAID_REVIEWS_PER_PR;
  return Math.min(MAX_REVIEWS_PER_PR, Math.max(MIN_REVIEWS_PER_PR, Math.floor(n)));
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * What a human is told on the pull request when the budget runs out.
 *
 * It says the number, why it is that number, and the one thing they can actually
 * do next — which is different on each tier, and telling a free workspace to
 * "raise the limit in Review settings" would send them to a control they are not
 * allowed to move.
 */
export function exhaustedMessage(b: Budget): string {
  const spent = `This pull request has used all ${b.limit} of its Cavix reviews.`;
  if (b.raisable) {
    return (
      `${spent} The Cavix check keeps the result of the last review, so nothing here has been ` +
      "cleared. Raise the per-pull-request limit under **Review settings**, or open a new pull " +
      "request for the remaining work."
    );
  }
  return (
    `${spent} That limit is fixed on the free tier and cannot be raised on this workspace. The ` +
    "Cavix check keeps the result of the last review, so nothing here has been cleared. Upgrade " +
    "to set your own limit, or open a new pull request for the remaining work."
  );
}
