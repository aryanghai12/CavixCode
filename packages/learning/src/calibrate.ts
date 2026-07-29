// Stage 12 — the learning loop. Turn a workspace's accept and reject history
// into a per-category confidence threshold, and hand it to Stage 9.
//
// THE THING THAT MAKES THIS HARD, and the reason the first version of this file
// would not have worked on real data:
//
//   The threshold acts on CONFIDENCE. The accept rate does not mention it. So
//   deriving a threshold from "this team rejects 90% of maintainability nits"
//   assumes the rejected findings sat at lower confidence than the accepted
//   ones, and on real data that is often false. An agent that is confidently
//   wrong is exactly the finding a team rejects. Raising the bar in that case
//   suppresses nothing, or suppresses the good findings alongside the bad, and
//   either way the dashboard reports that the loop is working.
//
// So nothing here is derived from the accept rate alone. Every threshold is the
// answer to a question about the confidence distribution of decisions this team
// actually made, and when the distribution gives no answer, the bar does not
// move and the reason says so. A calibration that refuses to act is a correct
// calibration; a calibration that acts on three decisions is not.
//
// Two independent questions, asked in this order:
//
//   RAISE  Is there a confidence level below which this team's rejections
//          cluster? The lowest cut that would have removed at least
//          `suppressShare` of the rejections while costing at most
//          `collateralShare` of the accepts. No such cut, no raise.
//
//   FALL   Did this team accept essentially everything in this category
//          (precision at or above `trustPrecision`)? Then show them more of it,
//          by `maxDrop` and no further.
//
// Four guards, because the failure modes here are not hypothetical:
//   1. A window (default 90 days), so a bad week ages out on its own.
//   2. A minimum per category, so ten decisions is the price of an opinion.
//   3. A minimum per workspace, below which none of this applies at all.
//   4. A ceiling of base + maxRise, which is a REFUSAL and not a cap: a category
//      needing a higher bar than that is left alone. Capping instead was the
//      first thing this did, and it produced a bar that suppressed nothing under
//      a sentence claiming it suppressed everything.
//   5. A minimum margin between the bar and the lowest finding the team kept, so
//      a 0.02 gap between accepts and rejects is read as the noise it is.

/**
 * One accept or reject, as the dashboard recorded it.
 *
 * `confidence` is optional because it has to be: decisions recorded before the
 * store kept the field cannot inform a confidence threshold, and pretending
 * otherwise would be the exact dishonesty this package exists to avoid. Those
 * decisions count toward the accept rates the dashboard shows and toward
 * nothing else.
 */
export interface DecisionRecord {
  category: string;
  agent?: string;
  source: string;
  /** The confidence the finding carried when it was posted, in [0,1]. */
  confidence?: number;
  accepted: boolean;
  /** ISO timestamp. Absent is treated as recent: the store always sets it. */
  at?: string;
}

/**
 * What Stage 10 should do about a category, learned from the same history.
 *
 * This is the OTHER half of the loop. Stage 9's threshold decides what a model
 * is trusted to SAY; this decides where the sandbox is worth SPENDING, and the
 * two answer different questions about the same data:
 *
 *   "always"  The team's accepts and rejects overlap at every confidence level,
 *             so no threshold separates them. Stage 9 correctly refuses to move
 *             the bar there, which leaves execution as the only instrument that
 *             can tell a real finding in this category from a plausible one. So
 *             prove them, including the ones the default gate would skip.
 *
 *   "never"   The team accepts essentially everything in this category. A proof
 *             changes no decision they were going to make, and a sandbox run is
 *             the most expensive thing in a review. Applies ONLY to findings the
 *             default gate would have verified merely for clearing the
 *             confidence bar: critical, high and security are never skipped,
 *             because those are the ones whose proof carries the product.
 *
 * Absent means no opinion, and the default gate applies unchanged.
 */
export type VerifyPolicy = "always" | "never";

/** What was decided about one category, and what Cavix did about it. */
export interface CategoryCalibration {
  category: string;
  /** The bar Stage 9 will use for this category. */
  threshold: number;
  /** Decisions with a usable confidence, inside the window, in this category. */
  samples: number;
  accepted: number;
  rejected: number;
  /** Did the bar actually move off the base? */
  moved: boolean;
  /** Why, in the team's own numbers. Rendered verbatim on the Learnings page. */
  reason: string;
  /** What Stage 10 does here, when the history says anything. See VerifyPolicy. */
  verify?: VerifyPolicy;
  /** Why, in the team's own numbers. Absent when `verify` is. */
  verifyReason?: string;
}

export interface OrgCalibration {
  /** The threshold every uncalibrated category keeps. */
  base: number;
  /**
   * category -> threshold, for the categories whose bar MOVED. A category that
   * is absent falls back to the pipeline's own default, which is the whole
   * point: an absent entry and a base-valued entry mean different things to a
   * reader, and only one of them is a claim.
   */
  thresholdByCategory: Record<string, number>;
  /**
   * category -> what Stage 10 does there. The Stage 10 half of the loop.
   *
   * Same rule as `thresholdByCategory`: only categories with an actual opinion
   * appear, because an absent entry and an entry that happens to equal the
   * default mean different things to a reader and only one of them is a claim.
   */
  verifyByCategory: Record<string, VerifyPolicy>;
  /** Every category with history, moved or not, with its reason. */
  categories: CategoryCalibration[];
  /** Laplace-smoothed accept rates, for display. Not used to set a threshold. */
  categoryAcceptRate: Record<string, number>;
  agentAcceptRate: Record<string, number>;
  /** Decisions inside the window. */
  sampleCount: number;
  /** ...of which carried a confidence, so could inform a threshold. */
  usableCount: number;
  /** False means nothing here is fed to Stage 9. */
  active: boolean;
  /** How many more decided findings before it becomes active. 0 once it is. */
  decisionsUntilActive: number;
  windowDays: number;
  generatedAt: string;
}

export interface CalibrateOptions {
  /** Stage 9's own default. Everything moves relative to this. */
  baseThreshold?: number;
  /** Decisions older than this are not evidence about today. */
  windowDays?: number;
  /** Decided findings a workspace needs before ANY of this applies. */
  minOrgDecisions?: number;
  /** Decided findings a category needs before its bar may move. */
  minCategoryDecisions?: number;
  /** A raise must remove at least this share of the category's rejections. */
  suppressShare?: number;
  /** ...and cost at most this share of its accepts. */
  collateralShare?: number;
  /** Accept rate at or above which a category's bar is lowered. */
  trustPrecision?: number;
  /**
   * Confidence that must separate the bar from the lowest finding the team
   * kept. Below this the "separation" is noise, and fitting to it is how a
   * calibration starts dropping good findings on a rounding error.
   */
  minMargin?: number;
  /**
   * The highest bar Cavix will apply, as a distance above base. A category
   * needing more than this is left alone rather than moved partway: it is what
   * "a category can be made quieter, never silenced" actually costs.
   */
  maxRise?: number;
  /** The floor, as a distance below base. */
  maxDrop?: number;
  /** Injectable clock, so the window is testable without waiting 90 days. */
  now?: number;
}

const DEFAULTS = {
  baseThreshold: 0.5,
  windowDays: 90,
  minOrgDecisions: 20,
  minCategoryDecisions: 10,
  suppressShare: 0.6,
  collateralShare: 0.2,
  trustPrecision: 0.9,
  minMargin: 0.05,
  maxRise: 0.25,
  maxDrop: 0.15,
};

/** A bar has to clear the base by this much before we call it a change. */
const MOVED_EPSILON = 0.01;

const DAY_MS = 86_400_000;

export function calibrate(decisions: DecisionRecord[], options: CalibrateOptions = {}): OrgCalibration {
  // Per field rather than a spread: an explicit `undefined` coming off an
  // options object must not clobber the default with undefined.
  const o = {
    baseThreshold: options.baseThreshold ?? DEFAULTS.baseThreshold,
    windowDays: options.windowDays ?? DEFAULTS.windowDays,
    minOrgDecisions: options.minOrgDecisions ?? DEFAULTS.minOrgDecisions,
    minCategoryDecisions: options.minCategoryDecisions ?? DEFAULTS.minCategoryDecisions,
    suppressShare: options.suppressShare ?? DEFAULTS.suppressShare,
    collateralShare: options.collateralShare ?? DEFAULTS.collateralShare,
    trustPrecision: options.trustPrecision ?? DEFAULTS.trustPrecision,
    minMargin: options.minMargin ?? DEFAULTS.minMargin,
    maxRise: options.maxRise ?? DEFAULTS.maxRise,
    maxDrop: options.maxDrop ?? DEFAULTS.maxDrop,
  };
  const now = options.now ?? Date.now();
  const cutoff = now - o.windowDays * DAY_MS;
  const ceiling = clamp01(o.baseThreshold + o.maxRise);
  const floor = clamp01(o.baseThreshold - o.maxDrop);

  const inWindow = decisions.filter((d) => withinWindow(d, cutoff));
  // Only decisions whose finding carried a confidence can say anything about
  // where a confidence bar belongs.
  const usable = inWindow.filter((d) => usableConfidence(d.confidence) !== null);

  const active = usable.length >= o.minOrgDecisions;

  const byCategory = new Map<string, DecisionRecord[]>();
  for (const d of usable) {
    const list = byCategory.get(d.category);
    if (list) list.push(d);
    else byCategory.set(d.category, [d]);
  }

  const categories: CategoryCalibration[] = [];
  const thresholdByCategory: Record<string, number> = {};
  const verifyByCategory: Record<string, VerifyPolicy> = {};

  for (const [category, rows] of byCategory) {
    const cal = calibrateCategory(category, rows, o, ceiling, floor);
    categories.push(cal);
    // Nothing is fed to Stage 9 or Stage 10 until the workspace as a whole has
    // enough history, even for a category that has plenty of its own.
    if (active && cal.moved) thresholdByCategory[category] = cal.threshold;
    if (active && cal.verify) verifyByCategory[category] = cal.verify;
  }

  categories.sort((a, b) => b.samples - a.samples || a.category.localeCompare(b.category));

  return {
    base: o.baseThreshold,
    thresholdByCategory,
    verifyByCategory,
    categories,
    categoryAcceptRate: acceptRate(inWindow, (d) => d.category),
    agentAcceptRate: acceptRate(inWindow.filter((d) => d.agent), (d) => d.agent as string),
    sampleCount: inWindow.length,
    usableCount: usable.length,
    active,
    decisionsUntilActive: Math.max(0, o.minOrgDecisions - usable.length),
    windowDays: o.windowDays,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * The bar for one category, and the sentence explaining it.
 *
 * Every branch here either names a measurement or refuses to move. There is no
 * branch that moves the bar on a hunch, and the "no bar separates them" branch
 * is expected to be the common one on real data, not an error case.
 */
function calibrateCategory(
  category: string,
  rows: DecisionRecord[],
  o: Required<Omit<CalibrateOptions, "now">>,
  ceiling: number,
  floor: number,
): CategoryCalibration {
  const base = o.baseThreshold;
  const accepted = rows.filter((d) => d.accepted);
  const rejected = rows.filter((d) => !d.accepted);
  const at = (d: DecisionRecord) => usableConfidence(d.confidence) as number;
  const stay = (reason: string): CategoryCalibration => ({
    category,
    threshold: base,
    samples: rows.length,
    accepted: accepted.length,
    rejected: rejected.length,
    moved: false,
    reason,
  });

  if (rows.length < o.minCategoryDecisions) {
    const need = o.minCategoryDecisions - rows.length;
    return stay(
      `${rows.length} decided so far. Cavix moves this bar after ${o.minCategoryDecisions}, ` +
        `so ${need} more ${need === 1 ? "decision" : "decisions"} to go.`,
    );
  }

  // ---- FALL: did they accept essentially all of it? ----
  //
  // Asked first, because at this accept rate there is no noise left to suppress
  // and "show me more of this" is the only signal the data carries.
  const precision = accepted.length / rows.length;
  if (precision >= o.trustPrecision) {
    return {
      category,
      threshold: floor,
      samples: rows.length,
      accepted: accepted.length,
      rejected: rejected.length,
      moved: Math.abs(floor - base) >= MOVED_EPSILON,
      reason:
        `${accepted.length} of ${rows.length} accepted. Your team trusts this category, so the bar drops ` +
        `to ${fmt(floor)} (was ${fmt(base)}) and you see more of it.`,
      // The Stage 10 half. A proof changes no decision this team was going to
      // make here, and a sandbox run is the most expensive thing in a review.
      // The gate still proves anything critical, high or security: skipping
      // those would be trading the product's own claim for the saving.
      verify: "never",
      verifyReason:
        `You accept ${Math.round(precision * 100)}% of this category, so proving one changes nothing you ` +
        `were going to do. Cavix stops spending sandbox time here, except on anything critical, high or ` +
        `security, which it still proves.`,
    };
  }

  // ---- RAISE: is there a level below which the rejections sit? ----
  const mustSuppress = rejected.length * o.suppressShare;
  const mayCost = accepted.length * o.collateralShare;
  /** Would a bar here clear enough rejections without taking the accepts too? */
  const meets = (cut: number): { rejects: number; accepts: number } | null => {
    const rejects = rejected.filter((d) => at(d) < cut).length;
    const accepts = accepted.filter((d) => at(d) < cut).length;
    return rejects >= mustSuppress && accepts <= mayCost ? { rejects, accepts } : null;
  };

  // Does the DEFAULT already do the job?
  //
  // This branch is why the page can be trusted. A team whose rejections all sat
  // at 0.40 has taught Cavix nothing it was not already doing, because the
  // standard bar of 0.50 was holding those back anyway. Without this, that team
  // is told "no bar separates them", which is false, or worse, given a moved
  // number that changes nothing.
  const already = meets(base);
  if (already) {
    return stay(
      `${rejected.length} of ${rows.length} rejected, and the standard bar of ${fmt(base)} was already ` +
        `holding ${Math.round((already.rejects / rejected.length) * 100)}% of them back. Nothing to change.`,
    );
  }

  // Candidates are the observed confidences, nudged above each one so a cut AT a
  // rejected finding's confidence actually excludes it. Ascending, so the first
  // that qualifies is the smallest bar that does the job: raise as little as the
  // evidence allows, never to the ceiling just because the ceiling is there.
  const candidates = [...new Set(rows.map(at))].sort((a, b) => a - b).map((c) => round2(c + 0.01));
  let neededAboveCeiling = false;
  let tooCloseToAnAccept = false;

  for (const cut of candidates) {
    if (cut <= base) continue; // not a raise

    // The ceiling is a REFUSAL, not a cap.
    //
    // Capping was the first thing this did and it produced a lie: a category
    // whose rejections all sat at 0.78 got the ceiling, 0.75, which suppresses
    // none of them, under a sentence claiming it would hold back 100%. A bar
    // Cavix will not raise far enough to be useful is a bar it should not move.
    if (cut > ceiling) {
      neededAboveCeiling = true;
      break; // every later candidate is higher still
    }

    const hit = meets(cut);
    if (!hit) continue;

    // Do not fit to noise.
    //
    // On real data the accepted and rejected confidences sit close together far
    // more often than they sit apart, and a cut wedged into a 0.02 gap is a
    // coin flip dressed as a measurement: the next finding at 0.79 versus 0.81
    // decides itself. Require real daylight between the bar and the lowest
    // finding this team actually kept.
    const survivingAccepts = accepted.map(at).filter((c) => c >= cut);
    if (survivingAccepts.length > 0 && Math.min(...survivingAccepts) - cut < o.minMargin) {
      tooCloseToAnAccept = true;
      continue;
    }

    const share = Math.round((hit.rejects / rejected.length) * 100);
    return {
      category,
      threshold: cut,
      samples: rows.length,
      accepted: accepted.length,
      rejected: rejected.length,
      moved: Math.abs(cut - base) >= MOVED_EPSILON,
      reason:
        `${rejected.length} of ${rows.length} rejected. A bar at ${fmt(cut)} would have held back ` +
        `${share}% of them` +
        (hit.accepts > 0 ? ` and ${hit.accepts} your team kept, ` : ` and none your team kept, `) +
        `so that is where it sits (was ${fmt(base)}).`,
    };
  }

  if (neededAboveCeiling) {
    return stay(
      `${rejected.length} of ${rows.length} rejected, but telling them from the ones you kept would need ` +
        `a bar above ${fmt(ceiling)}. Cavix will not raise one that far, because a category with no ` +
        `ceiling can be switched off entirely. This one is not a confidence problem.`,
    );
  }
  if (tooCloseToAnAccept) {
    return stay(
      `${rejected.length} rejected and ${accepted.length} accepted, separated by less than ` +
        `${fmt(o.minMargin)} of confidence. That gap is too narrow to be a real difference, so Cavix ` +
        `has not moved this one.`,
    );
  }

  // The honest outcome, and the one this will hit most often on real data. The
  // team rejects some of this category, but the rejections are not
  // lower-confidence than the accepts, so no bar tells them apart. Moving it
  // would drop the good findings at the same rate as the bad ones.
  //
  // And this is exactly where the Stage 10 half earns its place. "A confidence
  // threshold is the wrong instrument" is a statement about confidence, not a
  // shrug: what separates a real finding from a plausible one here is whether it
  // reproduces. So the sandbox runs on all of them, including the ones the
  // default gate would have skipped as low-confidence nits.
  return {
    ...stay(
      `${rejected.length} rejected and ${accepted.length} accepted, at overlapping confidence levels. ` +
        `No bar separates them, so Cavix has not moved this one. A confidence threshold is the wrong ` +
        `instrument here.`,
    ),
    verify: "always",
    verifyReason:
      `Because no confidence bar separates them, Cavix proves this category by execution instead: every ` +
      `finding here is reproduced in a sandbox before you see it, including the ones it would normally ` +
      `judge too small to be worth running.`,
  };
}

/** Laplace-smoothed accept rate per key. Display only: it sets no threshold. */
function acceptRate(items: DecisionRecord[], key: (d: DecisionRecord) => string): Record<string, number> {
  const acc = new Map<string, { yes: number; n: number }>();
  for (const d of items) {
    const k = key(d);
    const e = acc.get(k) ?? { yes: 0, n: 0 };
    e.n++;
    if (d.accepted) e.yes++;
    acc.set(k, e);
  }
  const out: Record<string, number> = {};
  for (const [k, { yes, n }] of acc) out[k] = (yes + 1) / (n + 2);
  return out;
}

/**
 * A confidence we can reason about, or null.
 *
 * Findings arrive from six sources and three of them are deterministic tools
 * that have no honest notion of confidence. A NaN, a string, or a number
 * outside [0,1] is not a low confidence, it is an absent one.
 */
function usableConfidence(c: unknown): number | null {
  if (typeof c !== "number" || !Number.isFinite(c)) return null;
  if (c < 0 || c > 1) return null;
  return c;
}

/** Undated decisions count as recent: the store always stamps one. */
function withinWindow(d: DecisionRecord, cutoff: number): boolean {
  if (!d.at) return true;
  const t = Date.parse(d.at);
  return Number.isNaN(t) ? true : t >= cutoff;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function fmt(n: number): string {
  return n.toFixed(2);
}
