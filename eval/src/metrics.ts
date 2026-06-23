// Precision/recall/F1/false-positive-rate for code review, measured against
// gold-labeled issues. Matching is location-based with a small line tolerance:
// a predicted finding "hits" a gold issue if it is in the same file within
// ±tolerance lines. This tolerance reflects reality — a reviewer pointing one
// line off from the exact defect is still correct — without being so loose that
// unrelated findings count as hits.

export interface GoldIssue {
  path: string;
  line: number;
  category?: string;
  severity?: string;
  label?: string;
}

export interface Prediction {
  path: string;
  line: number;
  category?: string;
}

export interface PRScore {
  id: string;
  goldCount: number;
  predCount: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface Aggregate {
  prs: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  /** Share of emitted findings that were wrong = FP/(TP+FP) = 1 − precision. */
  falsePositiveRate: number;
}

const DEFAULT_TOLERANCE = 2;

function hits(pred: Prediction, gold: GoldIssue, tol: number): boolean {
  return pred.path === gold.path && Math.abs(pred.line - gold.line) <= tol;
}

/** Score one PR: a gold is a TP if any prediction hits it; a prediction is a FP
 *  if it hits no gold. Each gold counts once; duplicate hits don't inflate TP. */
export function scorePR(
  id: string,
  gold: GoldIssue[],
  preds: Prediction[],
  tol: number = DEFAULT_TOLERANCE,
): PRScore {
  let tp = 0;
  for (const g of gold) {
    if (preds.some((p) => hits(p, g, tol))) tp++;
  }
  const fn = gold.length - tp;
  let fp = 0;
  for (const p of preds) {
    if (!gold.some((g) => hits(p, g, tol))) fp++;
  }
  const precision = preds.length === 0 ? (gold.length === 0 ? 1 : 0) : tp / (tp + fp);
  const recall = gold.length === 0 ? 1 : tp / (tp + fn);
  return { id, goldCount: gold.length, predCount: preds.length, tp, fp, fn, precision, recall, f1: f1(precision, recall) };
}

export function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** Micro-average across PRs (pool TP/FP/FN, then compute rates). */
export function aggregate(scores: PRScore[]): Aggregate {
  const tp = sum(scores, (s) => s.tp);
  const fp = sum(scores, (s) => s.fp);
  const fn = sum(scores, (s) => s.fn);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return {
    prs: scores.length,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: f1(precision, recall),
    falsePositiveRate: tp + fp === 0 ? 0 : fp / (tp + fp),
  };
}

function sum<T>(arr: T[], f: (t: T) => number): number {
  return arr.reduce((n, t) => n + f(t), 0);
}
