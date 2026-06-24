import { test } from "node:test";
import assert from "node:assert/strict";
import { CveFixesAdapter, caseToDiff } from "../src/benchmarks.ts";
import { phase2Predict } from "../src/phase1.ts";
import { scorePR } from "../src/metrics.ts";

test("CVEfixes adapter loads cases and the deterministic layer catches them", async () => {
  const cases = new CveFixesAdapter().load();
  assert.ok(cases.length >= 2, "sample CVEfixes cases present");
  for (const c of cases) {
    const preds = await phase2Predict({ id: c.id, title: c.id, language: c.language, diff: caseToDiff(c), gold: c.gold, simulated: [] });
    const score = scorePR(c.id, c.gold, preds);
    assert.equal(score.tp, c.gold.length, `${c.id} should be caught`);
    assert.equal(score.fp, 0, `${c.id} no false positives`);
  }
});

test("caseToDiff produces an all-added diff with correct line numbers", () => {
  const diff = caseToDiff({ id: "x", language: "js", files: [{ path: "a.js", content: "line1\nline2" }], gold: [] });
  assert.match(diff, /\+\+\+ b\/a\.js/);
  assert.match(diff, /@@ -0,0 \+1,2 @@/);
});
