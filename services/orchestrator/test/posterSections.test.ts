import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, ReviewResult } from "@cavix/core";
import type { LedgerEntry } from "@cavix/review-session";
import { buildReviewSubmission, fingerprintFromComment, inlineFingerprint } from "@cavix/orchestrator";

// The four sections this file covers all answer questions the old comment could
// not: what changed since I last looked, what can this reach, is it safe to
// ship, and what should I think about later.

const DIFF = `diff --git a/src/api/refund.ts b/src/api/refund.ts
--- a/src/api/refund.ts
+++ b/src/api/refund.ts
@@ -36,3 +36,6 @@ export async function refund(orderId: string, amount: number) {
   const order = await loadOrder(orderId);
+  const row = await db.query("SELECT * FROM orders WHERE id = " + orderId);
+  return settle(row, amount);
 }
`;

const REF = { owner: "acme", repo: "widgets", headSha: "abc1234567" };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    path: "src/api/refund.ts",
    line: 37,
    severity: "high",
    category: "security",
    title: "SQL injection via orderId",
    body: "orderId is concatenated into the query.",
    source: "llm",
    confidence: 0.9,
    ...over,
  };
}

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    fingerprint: "aaaa1111bbbb2222",
    path: "src/api/ledger.ts",
    line: 210,
    severity: "high",
    category: "correctness",
    title: "Refund is not idempotent under retry",
    firstSeenSha: "old1111",
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenSha: "old1111",
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    timesReported: 2,
    fileDigest: "digest",
    state: "open",
    ...over,
  };
}

function resultWith(...findings: Finding[]): ReviewResult {
  return {
    summary: "Adds a refund query.",
    model: "fake-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0,
    findings,
  };
}

const DELTA = { fromSha: "a3f8c2199", toSha: "7b2e904aa", commits: 2, filesReread: 4, unchangedFiles: 6 };

// ---------- Since your last push ----------

test("the delta section reports what this push changed about the review", () => {
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    delta: DELTA,
    resolved: [entry({ state: "resolved", resolution: "fixed", title: "Unchecked array index" })],
    carried: [entry()],
  });
  const b = submission.body;
  assert.match(b, /### ◈ Since your last push/);
  assert.match(b, /a3f8c21/);
  assert.match(b, /7b2e904/);
  assert.match(b, /2 commits/);
  assert.match(b, /4 files re-read/);
  assert.match(b, /1 finding cleared/);
  assert.match(b, /Unchecked array index/);
  assert.match(b, /1 finding raised/);
  assert.match(b, /1 finding still open/);
  // The row that earns trust in incremental review: it says what was NOT read.
  assert.match(b, /6 files unchanged since the last review/);
});

test("a first review has no delta section, because there is no since", () => {
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF });
  assert.doesNotMatch(submission.body, /Since your last push/);
});

test("a rewritten history says so, where the person who pushed will read it", () => {
  // Somebody pushed a fix and is about to notice nothing cleared. Without this
  // they conclude the tool stopped working.
  const { submission } = buildReviewSubmission(resultWith(), DIFF, {
    ref: REF,
    delta: DELTA,
    carried: [entry()],
    historyRewritten: true,
  });
  assert.match(submission.body, /History was rewritten/);
  assert.match(submission.body, /no longer exists/);
});

test("the delta section is omitted when there is nothing to report in it", () => {
  const { submission } = buildReviewSubmission(resultWith(), DIFF, {
    ref: REF,
    delta: { fromSha: "aaa", toSha: "bbb", filesReread: 1, unchangedFiles: 0 },
  });
  assert.doesNotMatch(submission.body, /Since your last push/);
});

// ---------- Impact Scope ----------

test("impact scope states reach, and always discloses how it was resolved", () => {
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    impact: {
      symbol: "refund",
      path: "src/api/refund.ts",
      signatureChanged: true,
      callSites: [{ path: "src/handlers/refund.ts", line: 22 }, { path: "src/jobs/nightly.ts", line: 88 }],
      consumers: ["acme/billing-worker"],
      tests: { selected: 12, passed: 11, failed: 1 },
      resolution: "exact",
      depth: 3,
    },
  });
  const b = submission.body;
  assert.match(b, /### ◈ Impact Scope/);
  assert.match(b, /`refund`/);
  assert.match(b, /changed signature/);
  assert.match(b, /2 call sites/);
  assert.match(b, /1 consumer/);
  assert.match(b, /12 tests/);
  assert.match(b, /1 failed/);
  // Mandatory: a reach claim that hides its method is the same fabricated
  // statistic the Scope module refuses to print.
  assert.match(b, /dynamic dispatch is not represented/);
  assert.match(b, /at depth 3/);
});

test("a heuristic trace says it is heuristic", () => {
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    impact: { callSites: [{ path: "a.ts" }], resolution: "heuristic" },
  });
  assert.match(submission.body, /resolved by name match, not by type resolution/);
});

test("impact scope never prints a zero, because a zero is a claim", () => {
  // "0 call sites" reads as "nothing calls this". That is a strong statement and
  // exactly the wrong one to make when the truth is that the indexer never ran.
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    impact: { symbol: "refund", callSites: [], consumers: [] },
  });
  assert.doesNotMatch(submission.body, /Impact Scope/);
});

test("no impact input means no impact section", () => {
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF });
  assert.doesNotMatch(submission.body, /Impact Scope/);
});

// ---------- Security Risks ----------

test("security findings get their own section, and it names the evidence", () => {
  const verified = finding({
    verification: {
      status: "VERIFIED",
      exploit: true,
      reproduced: true,
      reason: "the injection executed",
      steps: [{ step: "repro", cmd: "node poc.js", code: 1 }],
    },
  });
  const { submission } = buildReviewSubmission(resultWith(verified), DIFF, { ref: REF });
  const b = submission.body;
  assert.match(b, /### ▲ Security Risks/);
  assert.match(b, /1 exposure, highest high/);
  assert.match(b, /reproduced by execution/);
  assert.match(b, /⬢ verified/);
});

test("a scanner finding names its rule id as the evidence", () => {
  const f = finding({ source: "sast", ruleId: "sql-injection", severity: "critical" });
  const { submission } = buildReviewSubmission(resultWith(f), DIFF, { ref: REF });
  assert.match(submission.body, /`sql-injection`/);
  assert.match(submission.body, /sast/);
});

test("an unproven security finding says so rather than implying proof", () => {
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF });
  assert.match(submission.body, /reasoned, not executed/);
});

test("a review with no security findings has no security section", () => {
  const { submission } = buildReviewSubmission(resultWith(finding({ category: "style" })), DIFF, { ref: REF });
  assert.doesNotMatch(submission.body, /Security Risks/);
});

test("security findings still appear in their file section: restated, not relocated", () => {
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF });
  assert.match(submission.body, /#### .*refund\.ts/);
});

// ---------- Architectural Feedback ----------

test("architecture notes render last, capped, and never as blocking", () => {
  const notes = [1, 2, 3, 4, 5].map((n) =>
    finding({
      category: "architecture",
      severity: "info",
      title: `Structural note ${n}`,
      body: `Consequence ${n}.`,
      line: 37,
    }),
  );
  const { submission } = buildReviewSubmission(resultWith(...notes), DIFF, { ref: REF });
  const b = submission.body;
  assert.match(b, /### ◇ Architectural Feedback/);
  assert.match(b, /Nothing here blocks the merge/);
  // Capped inside its own section. A review with nine architectural opinions is
  // a review nobody finishes. They still appear in the findings list above,
  // because this section restates rather than relocates.
  const section = b.slice(b.indexOf("### ◇ Architectural Feedback"));
  assert.match(section, /Structural note 1/);
  assert.match(section, /and 2 more structural notes/);
  assert.doesNotMatch(section, /Structural note 4/);
  // Design opinions above defects train people to skim past the defects.
  assert.ok(b.indexOf("Architectural Feedback") > b.indexOf("### Findings"));
});

test("a deterministic finding is not mistaken for an architecture opinion", () => {
  const f = finding({ category: "architecture", source: "linter", ruleId: "layering" });
  const { submission } = buildReviewSubmission(resultWith(f), DIFF, { ref: REF });
  assert.doesNotMatch(submission.body, /Architectural Feedback/);
});

// ---------- inline comment identity ----------

test("every inline comment carries the fingerprint of the finding it is for", () => {
  const f = finding();
  const { submission } = buildReviewSubmission(resultWith(f), DIFF, { ref: REF });
  const c = submission.comments[0];
  assert.equal(fingerprintFromComment(c.body), fingerprintFromComment(inlineFingerprint(f)));
  assert.ok(fingerprintFromComment(c.body), "a fingerprint is present");
});

test("a comment Cavix did not write has no fingerprint, so a later run leaves it alone", () => {
  assert.equal(fingerprintFromComment("Looks good to me!"), null);
  assert.equal(fingerprintFromComment("<!-- cavix:inline -->\nold-style comment"), null);
});

// ---------- the run footer ----------

test("the footer states the tier mix, so cost is legible without token counts", () => {
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    delta: DELTA,
    routeMix: { T3: 2, T2: 6, T1: 31 },
  });
  const b = submission.body;
  assert.match(b, /routed T1 \(31\), T2 \(6\), T3 \(2\)/);
  assert.match(b, /a3f8c21 to 7b2e904/);
});

test("no route information means no routing clause invented for the footer", () => {
  const { submission } = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF });
  assert.doesNotMatch(submission.body, /routed /);
});

// ---------- house style holds for the new sections ----------

test("the new sections carry no emoji and no em dashes", () => {
  const { submission } = buildReviewSubmission(resultWith(finding(), finding({ category: "architecture", severity: "info", title: "Boundary", body: "Consequence." })), DIFF, {
    ref: REF,
    delta: DELTA,
    carried: [entry()],
    historyRewritten: true,
    impact: { symbol: "refund", callSites: [{ path: "a.ts" }], consumers: ["acme/b"], resolution: "exact" },
    routeMix: { T2: 1 },
  });
  const b = submission.body;
  assert.doesNotMatch(b, /\p{Emoji_Presentation}|️/u);
  assert.doesNotMatch(b, /[—–]/);
});
