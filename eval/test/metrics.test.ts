import { test } from "node:test";
import assert from "node:assert/strict";
import { scorePR, aggregate, f1 } from "../src/metrics.ts";

test("scorePR: exact + near hits count as TP, spurious as FP, misses as FN", () => {
  const gold = [
    { path: "a.js", line: 10 },
    { path: "a.js", line: 50 },
    { path: "b.py", line: 5 },
  ];
  const preds = [
    { path: "a.js", line: 11 }, // within ±2 of 10 → TP
    { path: "a.js", line: 90 }, // hits nothing → FP
    { path: "b.py", line: 5 }, // exact → TP
    // line 50 in a.js is missed → FN
  ];
  const s = scorePR("pr", gold, preds);
  assert.equal(s.tp, 2);
  assert.equal(s.fp, 1);
  assert.equal(s.fn, 1);
  assert.equal(round(s.precision), 0.67); // 2/3
  assert.equal(round(s.recall), 0.67); // 2/3
});

test("scorePR: clean PR with no gold and no preds is perfect", () => {
  const s = scorePR("clean", [], []);
  assert.equal(s.precision, 1);
  assert.equal(s.recall, 1);
  assert.equal(s.f1, 1);
});

test("scorePR: a false alarm on a clean PR tanks precision", () => {
  const s = scorePR("clean", [], [{ path: "a.js", line: 3 }]);
  assert.equal(s.fp, 1);
  assert.equal(s.precision, 0);
});

test("aggregate: micro-averages pooled TP/FP/FN", () => {
  const a = aggregate([
    scorePR("1", [{ path: "a", line: 1 }], [{ path: "a", line: 1 }]),
    scorePR("2", [{ path: "b", line: 1 }], [{ path: "z", line: 9 }]),
  ]);
  assert.equal(a.tp, 1);
  assert.equal(a.fp, 1);
  assert.equal(a.fn, 1);
  assert.equal(round(a.precision), 0.5);
  assert.equal(round(a.recall), 0.5);
  assert.equal(round(a.falsePositiveRate), 0.5);
});

test("f1 of zero precision/recall is 0", () => {
  assert.equal(f1(0, 0), 0);
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
