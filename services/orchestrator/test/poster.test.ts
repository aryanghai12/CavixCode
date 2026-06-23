import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewResult } from "@cavix/core";
import { buildReviewSubmission } from "@cavix/orchestrator";

const DIFF = `diff --git a/src/auth.js b/src/auth.js
--- a/src/auth.js
+++ b/src/auth.js
@@ -10,3 +10,5 @@ function login(user) {
   const token = sign(user);
   cache.set(user.id, token);
+  db.query("SELECT * FROM u WHERE id = " + user.id);
+  return token;
 }
`;

function resultWith(line: number): ReviewResult {
  return {
    summary: "Adds a DB query during login.",
    model: "fake-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0,
    findings: [
      {
        path: "src/auth.js",
        line,
        severity: "high",
        category: "security",
        title: "SQL injection via string concatenation",
        body: "user.id is concatenated into SQL.",
        suggestion: 'db.query("SELECT * FROM u WHERE id = ?", [user.id]);',
        source: "llm",
        confidence: 0.92,
      },
    ],
  };
}

test("buildReviewSubmission: anchors a finding on an added line as an inline comment", () => {
  const built = buildReviewSubmission(resultWith(12), DIFF); // line 12 is the added db.query
  assert.equal(built.inlineCount, 1);
  assert.equal(built.offDiffCount, 0);
  assert.equal(built.submission.event, "COMMENT");
  const c = built.submission.comments[0];
  assert.equal(c.path, "src/auth.js");
  assert.equal(c.line, 12);
  assert.match(c.body, /SQL injection/);
  assert.match(c.body, /```suggestion/); // one-click fix block present
});

test("buildReviewSubmission: a finding off the diff is folded into the summary, not dropped", () => {
  const built = buildReviewSubmission(resultWith(999), DIFF); // not a diff line
  assert.equal(built.inlineCount, 0);
  assert.equal(built.offDiffCount, 1);
  assert.match(built.submission.body, /Notes outside the diff/);
  assert.match(built.submission.body, /src\/auth\.js:999/);
});

test("buildReviewSubmission: clean review still posts a summary", () => {
  const clean: ReviewResult = {
    summary: "Small, safe change.",
    model: "fake-model",
    usage: { inputTokens: 5, outputTokens: 2 },
    costUsd: 0,
    findings: [],
  };
  const built = buildReviewSubmission(clean, DIFF);
  assert.equal(built.submission.comments.length, 0);
  assert.match(built.submission.body, /No issues found/);
});
