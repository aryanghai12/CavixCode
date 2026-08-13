import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@cavix/core";
import { screen, applyScreen, identifiersIn } from "@cavix/critic";

const DIFF = `diff --git a/src/api/refund.ts b/src/api/refund.ts
index 1111111..2222222 100644
--- a/src/api/refund.ts
+++ b/src/api/refund.ts
@@ -36,4 +36,8 @@ export async function refund(orderId: string, amount: number) {
   const order = await loadOrder(orderId);
-  const row = await db.query("SELECT * FROM orders WHERE id = $1", [orderId]);
+  const row = await db.query("SELECT * FROM orders WHERE id = " + orderId);
+  if (!order) {
+    return null;
+  }
   return settle(row, amount);
 }
`;

function finding(over: Partial<Finding> & Pick<Finding, "title">): Finding {
  return {
    path: "src/api/refund.ts",
    line: 38,
    severity: "high",
    category: "security",
    body: "",
    source: "llm",
    confidence: 0.9,
    ...over,
  } as Finding;
}

test("a finding in a file the change does not touch is unsupported", () => {
  const f = finding({ title: "Injection", path: "src/api/nowhere.ts" });
  const [r] = screen([f], { diff: DIFF });
  assert.equal(r.verdict, "UNSUPPORTED");
  assert.equal(r.checks.fileInDiff, false);
  assert.match(r.objection, /not part of this change/);
});

test("a line past the end of a known file is unsupported, and the objection says by how much", () => {
  const f = finding({ title: "Injection", line: 412 });
  const [r] = screen([f], { diff: DIFF, fileLines: new Map([["src/api/refund.ts", 300]]) });
  assert.equal(r.verdict, "UNSUPPORTED");
  assert.equal(r.checks.lineInRange, false);
  assert.match(r.objection, /past the end/);
  assert.match(r.objection, /300 lines/);
});

test("a line outside the diff but inside the file is fine: off-diff findings are legitimate", () => {
  const f = finding({ title: "Injection", line: 220 });
  const [r] = screen([f], { diff: DIFF, fileLines: new Map([["src/api/refund.ts", 300]]) });
  assert.equal(r.verdict, "SUPPORTED");
  assert.equal(r.checks.lineInRange, true);
});

test("a line number of zero or less is never a location", () => {
  const [r] = screen([finding({ title: "Injection", line: 0 })], { diff: DIFF });
  assert.equal(r.verdict, "UNSUPPORTED");
});

test("an invented helper is caught and named", () => {
  const f = finding({
    title: "Missing validation",
    body: "The `validateRefund` helper is never called before the query runs.",
  });
  const [r] = screen([f], { diff: DIFF });
  assert.equal(r.checks.symbolsResolve, false);
  assert.deepEqual(r.unresolvedSymbols, ["validateRefund"]);
  assert.match(r.objection, /appears nowhere in the code this review read/);
});

test("a symbol that IS in the diff resolves", () => {
  const f = finding({ title: "Injection", body: "`loadOrder` returns null and the result is used anyway." });
  const [r] = screen([f], { diff: DIFF });
  assert.equal(r.checks.symbolsResolve, true);
  assert.equal(r.verdict, "SUPPORTED");
});

test("a symbol the AST index knows resolves even when the diff does not show it", () => {
  const f = finding({ title: "Broken caller", body: "`issueCredit` calls this with two arguments." });
  const known = screen([f], { diff: DIFF, knownSymbols: ["issueCredit"] });
  assert.equal(known[0].checks.symbolsResolve, true);
  const unknown = screen([f], { diff: DIFF });
  assert.equal(unknown[0].checks.symbolsResolve, false);
});

test("a symbol quoted in the assembled context resolves", () => {
  const f = finding({ title: "Broken caller", body: "`issueCredit` calls this with two arguments." });
  const [r] = screen([f], { diff: DIFF, contextText: "export function issueCredit(id: string) {" });
  assert.equal(r.checks.symbolsResolve, true);
});

test("an unresolved symbol lowers confidence rather than deleting the finding", () => {
  const f = finding({ title: "Missing validation", body: "The `validateRefund` helper is missing.", confidence: 0.9 });
  const reports = screen([f], { diff: DIFF });
  assert.equal(reports[0].verdict, "REPAIRABLE");
  const { kept, dropped } = applyScreen([f], reports);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].confidence < 0.9, "confidence was reduced");
});

test("strictSymbols turns an unresolved symbol into a drop, for a complete corpus only", () => {
  const f = finding({ title: "Missing validation", body: "The `validateRefund` helper is missing." });
  const reports = screen([f], { diff: DIFF }, { strictSymbols: true });
  assert.equal(reports[0].verdict, "UNSUPPORTED");
});

test("prose in backticks is not mistaken for a symbol", () => {
  const f = finding({
    title: "Returns `null` instead of throwing",
    body: "The value is `undefined` when the `id` is missing, and the `string` is empty.",
  });
  const [r] = screen([f], { diff: DIFF });
  assert.deepEqual(r.unresolvedSymbols, []);
  assert.equal(r.verdict, "SUPPORTED");
});

test("a backticked expression is not treated as a resolvable identifier", () => {
  const f = finding({ title: "Bad call", body: "`order.total.toFixed(2)` rounds the wrong way." });
  const [r] = screen([f], { diff: DIFF });
  assert.deepEqual(r.unresolvedSymbols, []);
});

test("a deterministic finding is never dropped by the critic", () => {
  // A linter reporting a line the critic cannot place means the corpus is
  // incomplete, not that the linter hallucinated.
  const f = finding({ title: "Hardcoded secret", path: "src/api/elsewhere.ts", source: "secret", ruleId: "secret.aws" });
  const reports = screen([f], { diff: DIFF });
  assert.equal(reports[0].verdict, "UNSUPPORTED");
  const { kept, dropped } = applyScreen([f], reports);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
});

test("an immutable policy finding is never dropped by the critic", () => {
  const f = finding({ title: "Org rule", path: "src/api/elsewhere.ts", source: "policy", immutable: true });
  const reports = screen([f], { diff: DIFF });
  const { kept, dropped } = applyScreen([f], reports);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
});

test("a phantom LLM finding is dropped with a reason a human can read", () => {
  const f = finding({ title: "Injection", path: "src/api/imaginary.ts" });
  const reports = screen([f], { diff: DIFF });
  const { kept, dropped } = applyScreen([f], reports);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /^critic: /);
  assert.match(dropped[0].reason, /imaginary\.ts/);
});

test("screening is total: every finding gets exactly one report, in order", () => {
  const fs = [finding({ title: "A" }), finding({ title: "B", path: "gone.ts" }), finding({ title: "C" })];
  const reports = screen(fs, { diff: DIFF });
  assert.equal(reports.length, 3);
  assert.deepEqual(reports.map((r) => r.index), [0, 1, 2]);
  assert.equal(reports[1].verdict, "UNSUPPORTED");
});

test("identifiersIn ignores paths, spaces and short names", () => {
  assert.deepEqual(identifiersIn("see `src/api/refund.ts` and `a b` and `id`"), []);
  assert.deepEqual(identifiersIn("call `loadOrder` then `issue_credit`"), ["loadOrder", "issue_credit"]);
});

test("a legitimate off-diff finding deep in a long file is not downgraded", () => {
  // The heuristic this replaces said "the diff only reaches line 40, so line 400
  // is suspicious". It punished exactly the findings worth keeping: a change
  // that breaks a caller further down the file anchors outside the diff, and in
  // a five-hundred-line file every one of those correct findings looked "well
  // beyond anything the diff shows".
  const f = finding({ title: "Caller breaks", line: 480 });
  const [r] = screen([f], { diff: DIFF });
  assert.equal(r.verdict, "SUPPORTED");
  assert.equal(r.checks.lineInRange, true);
});

test("with the real file length known, past the end is still caught", () => {
  const [r] = screen([finding({ title: "Ghost", line: 480 })], {
    diff: DIFF,
    fileLines: new Map([["src/api/refund.ts", 300]]),
  });
  assert.equal(r.verdict, "UNSUPPORTED");
});
