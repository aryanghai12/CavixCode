import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, ReviewResult, Verification } from "@cavix/core";
import {
  buildPullDescription,
  buildReviewSubmission,
  SUMMARY_END,
  SUMMARY_START,
} from "@cavix/orchestrator";

const DIFF = `diff --git a/src/auth.js b/src/auth.js
--- a/src/auth.js
+++ b/src/auth.js
@@ -10,3 +10,5 @@ function login(user) {
   const token = sign(user);
   cache.set(user.id, token);
+  db.query("SELECT * FROM u WHERE id = " + user.id);
+  return token;
 }
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@ # Project
 # Project
-old line
+new line
`;

const REF = { owner: "acme", repo: "widgets", headSha: "abc123" };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    path: "src/auth.js",
    line: 12,
    severity: "high",
    category: "security",
    title: "SQL injection via string concatenation",
    body: "user.id is concatenated into SQL.",
    suggestion: 'db.query("SELECT * FROM u WHERE id = ?", [user.id]);',
    source: "llm",
    confidence: 0.92,
    ...over,
  };
}

function resultWith(...findings: Finding[]): ReviewResult {
  return {
    summary: "Adds a DB query during login.",
    model: "fake-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0,
    findings,
  };
}

test("buildReviewSubmission: anchors a finding on an added line as an inline comment", () => {
  const built = buildReviewSubmission(resultWith(finding()), DIFF); // line 12 is the added db.query
  assert.equal(built.inlineCount, 1);
  assert.equal(built.offDiffCount, 0);
  assert.equal(built.submission.event, "COMMENT");
  const c = built.submission.comments[0];
  assert.equal(c.path, "src/auth.js");
  assert.equal(c.line, 12);
  assert.equal(c.startLine, undefined);
  assert.match(c.body, /SQL injection/);
  assert.match(c.body, /```suggestion/); // one-click fix block present
  assert.match(c.body, /`src\/auth\.js` line 12 · confidence 92%/); // location travels with the body
});

test("buildReviewSubmission: a multi-line finding anchors as a range when both ends are in the diff", () => {
  const built = buildReviewSubmission(resultWith(finding({ line: 12, endLine: 13 })), DIFF);
  const c = built.submission.comments[0];
  assert.equal(c.startLine, 12);
  assert.equal(c.line, 13); // GitHub anchors multi-line comments at the END line
  assert.match(c.body, /lines 12–13/);
});

test("buildReviewSubmission: a range whose start is off the diff falls back to a single anchorable line", () => {
  const built = buildReviewSubmission(resultWith(finding({ line: 4, endLine: 12 })), DIFF);
  const c = built.submission.comments[0];
  assert.equal(c.startLine, undefined); // never send a start_line GitHub would 422 on
  assert.equal(c.line, 12);
});

test("buildReviewSubmission: the comment groups findings under their file with line numbers", () => {
  const built = buildReviewSubmission(
    resultWith(
      finding(),
      finding({ line: 13, severity: "medium", category: "correctness", title: "Token returned unchecked" }),
      finding({ path: "README.md", line: 2, severity: "low", category: "docs", title: "Stale wording" }),
    ),
    DIFF,
    { ref: REF },
  );
  const body = built.submission.body;

  assert.match(body, /## 🔬 Cavix review/);
  assert.match(body, /\*\*3 findings\*\* across \*\*2 files\*\*/);
  assert.match(body, /🟧 high: 1 · 🟨 medium: 1 · 🟦 low: 1/);

  // A heading per file, worst-affected first, each with a per-finding table.
  const authHeading = body.indexOf("#### 🟧 [`src/auth.js`]");
  const readmeHeading = body.indexOf("#### 🟦 [`README.md`]");
  assert.ok(authHeading > -1 && readmeHeading > -1, "both files get a heading");
  assert.ok(authHeading < readmeHeading, "the file with the worst finding leads");
  assert.match(body, /\| Line \| Severity \| Category \| Finding \| Detail \|/);

  // Every finding row names its line and links it at the reviewed commit.
  assert.match(body, /\| \[12\]\(https:\/\/github\.com\/acme\/widgets\/blob\/abc123\/src\/auth\.js#L12\) \| 🟧 high \| security \| SQL injection/);
  assert.match(body, /\| \[13\]\(\S+#L13\) \| 🟨 medium \| correctness \| Token returned unchecked/);
  assert.match(body, /💬 inline/); // detail lives on the line itself
});

test("buildReviewSubmission: without a ref the comment still names paths and lines, just unlinked", () => {
  const built = buildReviewSubmission(resultWith(finding()), DIFF);
  assert.match(built.submission.body, /#### 🟧 `src\/auth\.js`/);
  assert.match(built.submission.body, /\| 12 \| 🟧 high \|/);
  assert.doesNotMatch(built.submission.body, /https:\/\/github\.com/);
});

test("buildReviewSubmission: a finding off the diff keeps its full explanation in the summary", () => {
  const built = buildReviewSubmission(resultWith(finding({ line: 999 })), DIFF); // not a diff line
  assert.equal(built.inlineCount, 0);
  assert.equal(built.offDiffCount, 1);
  const body = built.submission.body;
  assert.match(body, /\| 999 \| 🟧 high \| security \| SQL injection/);
  assert.match(body, /📄 below/);
  assert.match(body, /1 finding not on a changed line/);
  assert.match(body, /`src\/auth\.js` line 999/);
  assert.match(body, /user\.id is concatenated into SQL\./); // the body is not lost
});

test("buildReviewSubmission: a pipe in a title cannot break the table", () => {
  const built = buildReviewSubmission(resultWith(finding({ title: "a | b" })), DIFF);
  assert.match(built.submission.body, /a \\\| b/);
});

test("buildReviewSubmission: the summary lives in the description, not the comment", () => {
  const body = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF }).submission.body;
  assert.doesNotMatch(body, /### Summary/);
  assert.doesNotMatch(body, /### Changes/);
  assert.match(body, /summary and walkthrough are in the PR description/);
  assert.match(body, /### Findings/); // the findings are still here
});

test("buildReviewSubmission: the summary falls back into the comment when the description is unwritable", () => {
  const body = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    includeSummary: true,
  }).submission.body;
  assert.match(body, /### Summary\n\nAdds a DB query during login\./);
  assert.match(body, /### Changes/);
  assert.doesNotMatch(body, /are in the PR description/);
});

test("buildReviewSubmission: clean review still posts a comment saying so", () => {
  const clean: ReviewResult = {
    summary: "Small, safe change.",
    model: "fake-model",
    usage: { inputTokens: 5, outputTokens: 2 },
    costUsd: 0,
    findings: [],
  };
  const built = buildReviewSubmission(clean, DIFF, { ref: REF });
  assert.equal(built.submission.comments.length, 0);
  assert.match(built.submission.body, /✅ \*\*No issues found\*\* in the 2 changed files/);
});

test("buildReviewSubmission: a huge review is trimmed to fit GitHub's comment limit", () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    finding({ line: 12, title: `Issue ${i}`, body: "x".repeat(600), suggestion: undefined }),
  );
  const built = buildReviewSubmission(resultWith(...many), DIFF, { ref: REF });
  assert.ok(built.submission.body.length <= 65536, "body fits in a GitHub comment");
  assert.match(built.submission.body, /## 🔬 Cavix review/);
});

// ── verification: the proof a reader can check ────────────────────────────────

const PROOF: Verification = {
  status: "VERIFIED",
  exploit: false,
  reproduced: true,
  fixWorks: true,
  suitePasses: true,
  reason: "bug reproduced by a failing test in the sandbox; suggested fix resolves it",
  testPath: "auth.repro.test.mjs",
  steps: [
    { step: "repro", cmd: "node --test auth.repro.test.mjs", code: 1 },
    { step: "after-fix", cmd: "node --test auth.repro.test.mjs", code: 0 },
    { step: "suite", cmd: "node --test", code: 0 },
  ],
};

test("buildReviewSubmission: a verified finding carries its sandbox transcript inline", () => {
  const built = buildReviewSubmission(resultWith(finding({ verification: PROOF })), DIFF, { ref: REF });
  assert.equal(built.verifiedCount, 1);
  const c = built.submission.comments[0].body;
  assert.match(c, /\*\*✅ verified · 🟧 high · security\*\* — SQL injection/);
  assert.match(c, /\*\*Proof\*\* — reproduced in a sealed sandbox:/);
  assert.match(c, /\[repro\] +node --test auth\.repro\.test\.mjs +→ exit 1 +bug reproduced/);
  assert.match(c, /\[after-fix\] .*→ exit 0 +suggested fix resolves it/);
  assert.match(c, /\[suite\] .*→ exit 0 +existing suite still green/);
  assert.match(c, /Reproduction: `auth\.repro\.test\.mjs`/);
  // And the row is marked, so the badge is visible without opening the file.
  assert.match(built.submission.body, /\| ✅ SQL injection via string concatenation \|/);
  assert.match(built.submission.body, /✅ 1 reproduced in a sandbox/);
});

test("buildReviewSubmission: an exploit proof is described as an exploit", () => {
  const built = buildReviewSubmission(
    resultWith(finding({ verification: { ...PROOF, exploit: true, fixWorks: undefined, suitePasses: undefined } })),
    DIFF,
    { ref: REF },
  );
  const c = built.submission.comments[0].body;
  assert.match(c, /the PoC exploit ran against this code in a sealed sandbox/);
  assert.match(c, /→ exit 1 +exploit succeeded/);
});

test("buildReviewSubmission: suppressed findings are stated, not hidden", () => {
  const built = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF, suppressedCount: 2 });
  assert.match(
    built.submission.body,
    /🔕 2 findings suppressed after the sandbox could not reproduce them/,
  );
});

// ── the PR description ────────────────────────────────────────────────────────

test("buildPullDescription: writes the summary and walkthrough below the author's text", () => {
  const result = resultWith(finding());
  result.walkthrough = [{ path: "src/auth.js", summary: "Look up the user during login" }];
  result.effort = 4;
  const body = buildPullDescription("Fixes #42.\n\nMy own notes.", result, DIFF, REF);

  assert.match(body, /^Fixes #42\.\n\nMy own notes\./, "the author's description is kept, first");
  assert.ok(body.includes(SUMMARY_START) && body.includes(SUMMARY_END), "the block is marked");
  assert.match(body, /### Summary\n\nAdds a DB query during login\./);
  assert.match(body, /<sub>2 files changed · `\+3 −1` · review effort ●●●●○ 4\/5<\/sub>/);

  // The walkthrough: every changed file, what it now does, and which lines moved.
  assert.match(body, /### Changes/);
  assert.match(body, /\| File \| What changed \| Lines \| Findings \|/);
  assert.match(body, /\| \[`src\/auth\.js`\]\S+ \| Look up the user during login \| `\+2 −0` · L12–L13 \| 1 \|/);
  // README.md has no walkthrough entry: the row still exists, described from the
  // diff, so a file can never vanish from the map because the model skipped it.
  assert.match(body, /\| \[`README\.md`\]\S+ \| In `# Project` \| `\+1 −1` · L2 \| — \|/);
});

test("buildPullDescription: review effort falls back to a size estimate when the model gives none", () => {
  const body = buildPullDescription("", resultWith(finding()), DIFF, REF);
  assert.match(body, /review effort ●○○○○ 1\/5/); // 4 changed lines across 2 files
});

test("buildPullDescription: a re-review replaces its own block instead of stacking", () => {
  const first = buildPullDescription("Author notes.", resultWith(finding()), DIFF, REF);

  const rerun = resultWith(finding());
  rerun.summary = "Second look after a force-push.";
  const second = buildPullDescription(first, rerun, DIFF, REF);

  assert.equal(second.split(SUMMARY_START).length - 1, 1, "exactly one Cavix block");
  assert.match(second, /^Author notes\./, "the author's text survives the rewrite");
  assert.match(second, /Second look after a force-push\./);
  assert.doesNotMatch(second, /Adds a DB query during login/, "the stale summary is gone");
});

test("buildPullDescription: an empty description gets the block alone, with no stray separator", () => {
  const body = buildPullDescription("", resultWith(finding()), DIFF, REF);
  assert.ok(body.startsWith(SUMMARY_START));
  assert.ok(body.endsWith(SUMMARY_END));
  assert.doesNotMatch(body, /^---/m);
});
