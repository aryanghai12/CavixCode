import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, ReviewResult, Verification } from "@cavix/core";
import type { CallTrace } from "@cavix/analyzer";
import {
  buildPullDescription,
  buildReviewSubmission,
  plain,
  SUMMARY_END,
  SUMMARY_START,
} from "@cavix/orchestrator";
import { ALL_SECTIONS } from "../src/byok/reviewConfig.ts";

/** A traced call path, as the deep review would hand one over. */
const TRACE: CallTrace = {
  participants: ["src/auth.js", "src/db.js"],
  steps: [
    { fromPath: "src/auth.js", fromSymbol: "login", toPath: "src/db.js", toSymbol: "query", line: 12 },
    { fromPath: "src/auth.js", fromSymbol: "login", toPath: "src/db.js", toSymbol: "cacheSet", line: 11 },
  ],
  entryPoints: ["login"],
  truncated: false,
};

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

/**
 * Real emoji, as opposed to the geometric marks the house style is built from.
 *
 * Emoji_Presentation catches anything that renders as a colour pictograph by
 * default (🔬 ✅ 🟧), and U+FE0F catches a text glyph forced into emoji
 * presentation. The marks Cavix does use (◆ ◈ ◇ ▪ ⬢ ▲ ✓) are text-presentation
 * shapes and pass this cleanly.
 */
const EMOJI = /\p{Emoji_Presentation}|️/u;

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
  // The severity is the colour of the callout the headline arrives in.
  // A hidden marker leads the body, so a later run can recognise its own inline
  // comments on a platform that has no review object to ask. It renders as
  // nothing, which is why the alert callout is still the first thing seen.
  // Two hidden markers, then the alert. The first says "Cavix wrote this"; the
  // second says WHICH finding it is for, so a later review can update this
  // comment in place instead of posting a second copy of it beside the first.
  assert.match(
    c.body,
    /^<!-- cavix:inline -->\n<!-- cavix:inline:fp=[0-9a-f]+ -->\n> \[!WARNING\]\n> \*\*◈ SQL injection via string concatenation\*\*/,
  );
  assert.match(c.body, /<kbd>high<\/kbd> <kbd>security<\/kbd> <kbd>confidence 92%<\/kbd>/);
  assert.match(c.body, /<sub>`src\/auth\.js` line 12<\/sub>/); // location travels with the body
});

test("buildReviewSubmission: a multi-line finding anchors as a range when both ends are in the diff", () => {
  const built = buildReviewSubmission(resultWith(finding({ line: 12, endLine: 13 })), DIFF);
  const c = built.submission.comments[0];
  assert.equal(c.startLine, 12);
  assert.equal(c.line, 13); // GitHub anchors multi-line comments at the END line
  assert.match(c.body, /lines 12-13/);
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

  assert.match(body, /## ◈ Cavix Review/);
  // The verdict is a GitHub alert callout: amber, because a high was found.
  assert.match(body, /> \[!WARNING\]\n> \*\*3 findings\*\* across \*\*2 files\*\*/);
  assert.match(body, /> ◈ 1 high · ◇ 1 medium · ▪ 1 low/);

  // A heading per file, worst-affected first, each with a per-finding table.
  const authHeading = body.indexOf("#### ◈ [`src/auth.js`]");
  const readmeHeading = body.indexOf("#### ▪ [`README.md`]");
  assert.ok(authHeading > -1 && readmeHeading > -1, "both files get a heading");
  assert.ok(authHeading < readmeHeading, "the file with the worst finding leads");
  assert.match(body, /\| \| Line \| Finding \| Detail \|/);

  // Every finding row names its line and links it at the reviewed commit, with
  // the headline in bold over a dim line of provenance.
  assert.match(
    body,
    /\| ◈ \| \[12\]\(https:\/\/github\.com\/acme\/widgets\/blob\/abc123\/src\/auth\.js#L12\) \| \*\*SQL injection via string concatenation\*\*<br><sub>high · security · confidence 92%<\/sub> \|/,
  );
  assert.match(body, /\| ◇ \| \[13\]\(\S+#L13\) \| \*\*Token returned unchecked\*\*<br><sub>medium · correctness/);
  assert.match(body, /▸ inline/); // detail lives on the line itself
});

test("buildReviewSubmission: without a ref the comment still names paths and lines, just unlinked", () => {
  const built = buildReviewSubmission(resultWith(finding()), DIFF);
  assert.match(built.submission.body, /#### ◈ `src\/auth\.js`/);
  assert.match(built.submission.body, /\| ◈ \| 12 \| \*\*SQL injection/);
  assert.doesNotMatch(built.submission.body, /https:\/\/github\.com/);
});

// Every permalink used to be built against a hardcoded github.com, so a GitLab
// or Bitbucket reader who clicked a finding's line number left for a github.com
// repository that does not exist, and a GitHub Enterprise reader left their own
// network. Four hosts, four URL grammars, and none is derivable from another.
test("buildReviewSubmission: permalinks are built for the host the review is going to", () => {
  const gitlab = buildReviewSubmission(resultWith(finding({ endLine: 13 })), DIFF, {
    ref: { ...REF, host: "https://gitlab.example.com", platform: "gitlab" },
  }).submission.body;
  assert.match(
    gitlab,
    /https:\/\/gitlab\.example\.com\/acme\/widgets\/-\/blob\/abc123\/src\/auth\.js#L12-13/,
    "GitLab puts the commit under /-/blob and writes a range as L12-13",
  );
  assert.doesNotMatch(gitlab, /github\.com/);

  const bitbucket = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: { ...REF, host: "https://bitbucket.org", platform: "bitbucket" },
  }).submission.body;
  assert.match(
    bitbucket,
    /https:\/\/bitbucket\.org\/acme\/widgets\/src\/abc123\/src\/auth\.js#lines-12/,
    "Bitbucket serves files under /src and anchors lines as #lines-N",
  );

  const azure = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: { ...REF, owner: "acme/payments", host: "https://dev.azure.com", platform: "azure-devops" },
  }).submission.body;
  assert.match(
    azure,
    /https:\/\/dev\.azure\.com\/acme\/payments\/_git\/widgets\?path=\/src\/auth\.js&version=GCabc123&line=12/,
    "Azure passes the path, the commit (GC = a commit, not a branch) and the line as query parameters",
  );

  // A GitHub Enterprise install serves files from its own host, not github.com.
  const ghe = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: { ...REF, host: "https://ghe.acme.internal", platform: "github" },
  }).submission.body;
  assert.match(ghe, /https:\/\/ghe\.acme\.internal\/acme\/widgets\/blob\/abc123\/src\/auth\.js#L12/);
  assert.doesNotMatch(ghe, /github\.com/);
});

test("buildReviewSubmission: a host we cannot name renders paths as text, never as a wrong link", () => {
  // "" is what `webRootFrom` returns for an unparseable API base. A review that
  // names a file without linking it is complete; one that links it to the wrong
  // repository is worse than one that does not link it at all.
  // Badges off, so the only URLs left in the body would be permalinks.
  const body = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: { ...REF, host: "", platform: "gitlab" },
    badges: false,
  }).submission.body;
  assert.match(body, /#### ◈ `src\/auth\.js`/);
  assert.match(body, /\| ◈ \| 12 \| \*\*SQL injection/);
  assert.doesNotMatch(body, /https:\/\//);
});

test("buildReviewSubmission: a finding off the diff keeps its full explanation in the summary", () => {
  const built = buildReviewSubmission(resultWith(finding({ line: 999 })), DIFF); // not a diff line
  assert.equal(built.inlineCount, 0);
  assert.equal(built.offDiffCount, 1);
  const body = built.submission.body;
  assert.match(body, /\| ◈ \| 999 \| \*\*SQL injection via string concatenation\*\*/);
  assert.match(body, /▾ below/);
  assert.match(body, /Full detail for 1 finding not on a changed line/);
  assert.match(body, /`src\/auth\.js` line 999/);
  assert.match(body, /user\.id is concatenated into SQL\./); // the body is not lost
  // Off the diff there is no one-click Apply button, so the fix is a highlighted
  // code block instead of a bare fence.
  assert.match(body, /\*\*Suggested fix\*\*\n\n```js\n/);
});

test("buildReviewSubmission: a pipe in a title cannot break the table", () => {
  const built = buildReviewSubmission(resultWith(finding({ title: "a | b" })), DIFF);
  assert.match(built.submission.body, /a \\\| b/);
});

test("buildReviewSubmission: the summary lives in the description, not the comment", () => {
  const body = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF }).submission.body;
  assert.doesNotMatch(body, /### Summary/);
  assert.doesNotMatch(body, /### What Changed/);
  assert.match(body, /summary and walkthrough are in the PR description/);
  assert.match(body, /### Findings/); // the findings are still here
});

test("buildReviewSubmission: the summary falls back into the comment when the description is unwritable", () => {
  const body = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    includeSummary: true,
  }).submission.body;
  assert.match(body, /### Summary\n\nAdds a DB query during login\./);
  assert.match(body, /### What Changed/);
  assert.doesNotMatch(body, /are in the PR description/);
  assert.equal(
    body.split("> [!WARNING]\n> **1 finding**").length - 1,
    1,
    "exactly one verdict callout, not one per block",
  );
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
  assert.match(built.submission.body, /> \[!TIP\]\n> \*\*Clean pass\.\*\* Nothing to raise on the changed lines\./);
  // Nothing was proven, so the footer must not talk about the sandbox.
  assert.doesNotMatch(built.submission.body, /sealed sandbox/);
  // A clean review still states its security read: "we looked and found nothing"
  // is the fact the reviewer wants on the record.
  assert.match(built.submission.body, /\| ⬢ \| \*\*Security Gate\*\* \| Clear, nothing raised on the changed lines \|/);
});

test("buildReviewSubmission: a huge review is trimmed to fit GitHub's comment limit", () => {
  // Spread across many files so there are many sections to drop — a single
  // enormous file section cannot be trimmed without losing every finding.
  const many = Array.from({ length: 400 }, (_, i) =>
    finding({
      path: `src/module-${i % 120}/handler.ts`,
      line: 12,
      title: `Issue ${i} with a fairly long headline so the table rows carry weight`,
      body: "x".repeat(600),
      suggestion: undefined,
    }),
  );
  const built = buildReviewSubmission(resultWith(...many), DIFF, { ref: REF });
  const body = built.submission.body;
  assert.ok(body.length <= 60000, `body stays under the poster's own cap (was ${body.length})`);
  assert.match(body, /## ◈ Cavix Review/);
  // Prove the truncation path actually ran, rather than the fixture just fitting.
  assert.match(body, /further sections? omitted\. This review is too large/);
  // Sections are dropped whole: no heading may be left with its table missing.
  assert.doesNotMatch(body, /#### [^\n]*\n\n\| \| Line \| Finding \| Detail \|\n\| :--: \| ---: \| :--- \| :--- \|\n\n/);
});

// ── the Review Scope & Effort module: the block that opens the review ─────────

test("the review opens with a Scope module of measured signals, not git stats", () => {
  const result = resultWith(finding());
  result.effort = 3;
  const body = buildReviewSubmission(result, DIFF, { ref: REF }).submission.body;

  // It leads: nothing but the title and the badge strip sits above it.
  assert.ok(body.indexOf("### ◈ Review Scope & Effort") < body.indexOf("> [!WARNING]"));
  assert.match(body, /\| \| Signal \| Reading \|/);

  // Reach, in terms Cavix derived rather than the counts GitHub already prints.
  assert.match(body, /\| ◇ \| \*\*Deep Scan\*\* \| 2 subsystems traversed · 2 changed regions · JavaScript, Markdown \|/);
  // The named symbols the change lands inside, read off the hunk headers.
  assert.match(body, /\| ◇ \| \*\*Symbol Scope\*\* \| `login`, `Project` \|/);
  assert.match(body, /\| ▲ \| \*\*Security Gate\*\* \| ◈ 1 exposure, highest \*\*high\*\* \|/);
  assert.match(body, /\| ◇ \| \*\*Confidence Score\*\* \| ●●●●● 92% mean across the findings raised \|/);
  assert.match(body, /\| ◇ \| \*\*Review Effort\*\* \| ◆◆◆◇◇ \*\*3 of 5\*\*, a focused read \|/);

  // The banned git stats: GitHub renders all three directly above this comment.
  assert.doesNotMatch(body, /\+\d+ \/ -\d+/);
  assert.doesNotMatch(body, /files? changed/i);
});

test("the Scope module never claims a stage that did not run, and reports one that did", () => {
  const bare = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF }).submission.body;
  assert.doesNotMatch(bare, /AST Verification/, "no AST row without a Stage 4 measurement");
  assert.doesNotMatch(bare, /Blast Radius/);
  assert.doesNotMatch(bare, /Execution Proof/, "nothing was proven and nothing disproven");

  const rich = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    signals: { astSymbols: 128, tools: 24, agents: 7, consumers: 3 },
  }).submission.body;
  assert.match(rich, /\*\*AST Verification\*\* \| 128 symbols resolved, cross-file impact mapped/);
  assert.match(rich, /\*\*Deterministic Pass\*\* \| 24 linter, SAST and secret tools run over the change/);
  assert.match(rich, /\*\*Ensemble\*\* \| 7 specialist agents read this diff independently/);
  assert.match(rich, /\*\*Blast Radius\*\* \| 3 downstream call sites checked in other repositories/);
});

test("the badge strip is bounded, coloured, and switchable off for an air gap", () => {
  const on = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF }).submission.body;
  const badges = on.match(/!\[[^\]]*\]\(https:\/\/img\.shields\.io\/\S+?\)/g) ?? [];
  assert.ok(badges.length > 0 && badges.length <= 5, `bounded strip, got ${badges.length}`);
  assert.match(on, /!\[Security: 1 high\]\(https:\/\/img\.shields\.io\/badge\/Security-1_high-C2410C\?/);
  assert.match(on, /!\[Review Effort: 1 of 5\]\(\S+Review_Effort-1_of_5-475569\?/);

  const off = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF, badges: false }).submission.body;
  assert.doesNotMatch(off, /img\.shields\.io/);
  // The facts survive the switch: only the colour was in the images.
  assert.match(off, /\*\*Security Gate\*\* \| ◈ 1 exposure, highest \*\*high\*\*/);
  assert.match(off, /### ◈ Review Scope & Effort/);
});

test("the Scope module is one of the dashboard's section toggles", () => {
  const body = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    sections: { summary: true, changedFiles: true, sequenceDiagram: true, reviewEffort: false, inlineFindings: true, proof: true },
  }).submission.body;
  assert.doesNotMatch(body, /Review Scope & Effort/);
  assert.doesNotMatch(body, /img\.shields\.io/);
  assert.match(body, /### Findings/, "the findings are untouched by that toggle");
});

test("findings at high or above are called out before the tables, worst flavour first", () => {
  const body = buildReviewSubmission(
    resultWith(
      finding({ line: 12, severity: "critical", title: "SQL injection via string concatenation" }),
      finding({ line: 13, severity: "high", title: "Token returned unchecked" }),
      finding({ path: "README.md", line: 2, severity: "low", title: "Stale wording" }),
    ),
    DIFF,
    { ref: REF },
  ).submission.body;

  assert.match(body, /### Findings\n\n> \[!CAUTION\]\n> \*\*Fix these first\*\*/);
  assert.match(
    body,
    /> ◆ \*\*SQL injection via string concatenation\*\* · \[`src\/auth\.js` line 12\]\(\S+#L12\)/,
  );
  assert.match(body, /> ◈ \*\*Token returned unchecked\*\* · \[`src\/auth\.js` line 13\]\(\S+#L13\)/);
  assert.doesNotMatch(body, /> ▪ \*\*Stale wording\*\*/, "a low is not a must-fix");
});

test("the must-fix callout caps itself rather than listing thirty items", () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    finding({ line: 12, severity: "high", title: `Issue ${i}` }),
  );
  const body = buildReviewSubmission(resultWith(...many), DIFF, { ref: REF }).submission.body;
  assert.match(body, /> \[!WARNING\]\n> \*\*Fix these first\*\*/);
  assert.match(body, /and 4 more at high or above, listed below/);
});

test("no finding at high or above means no must-fix callout at all", () => {
  const body = buildReviewSubmission(resultWith(finding({ severity: "low" })), DIFF, { ref: REF }).submission.body;
  assert.match(body, /### Findings/);
  assert.doesNotMatch(body, /Fix these first/);
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
  assert.match(c, /> \*\*◈ SQL injection via string concatenation\*\*/);
  assert.match(c, /<kbd>⬢ verified<\/kbd> <kbd>high<\/kbd> <kbd>security<\/kbd> <kbd>confidence 92%<\/kbd>/);
  assert.match(c, /\*\*⬢ Execution proof\.\*\* Reproduced in a sealed sandbox:/);
  assert.match(c, /\[repro\] +node --test auth\.repro\.test\.mjs +→ exit 1 +bug reproduced/);
  assert.match(c, /\[after-fix\] .*→ exit 0 +suggested fix resolves it/);
  assert.match(c, /\[suite\] .*→ exit 0 +existing suite still green/);
  assert.match(c, /Reproduction: `auth\.repro\.test\.mjs`/);
  // And the row is marked, so the badge is visible without opening the file.
  assert.match(built.submission.body, /\*\*SQL injection via string concatenation\*\* ⬢<br>/);
  assert.match(built.submission.body, /⬢ 1 reproduced in a sandbox/);
  // The proof is the product claim, so it gets its own row in the Scope module.
  assert.match(
    built.submission.body,
    /\| ⬢ \| \*\*Execution Proof\*\* \| Every posted finding was reproduced in a sealed sandbox \|/,
  );
  assert.match(built.submission.body, /!\[Execution Proof: 1 verified\]\(\S+-047857\?/);
});

test("buildReviewSubmission: an exploit proof is described as an exploit", () => {
  const built = buildReviewSubmission(
    resultWith(finding({ verification: { ...PROOF, exploit: true, fixWorks: undefined, suitePasses: undefined } })),
    DIFF,
    { ref: REF },
  );
  const c = built.submission.comments[0].body;
  assert.match(c, /\*\*⬢ Execution proof\.\*\* The PoC exploit ran against this code in a sealed sandbox/);
  assert.match(c, /→ exit 1 +exploit succeeded/);
});

test("buildReviewSubmission: suppressed findings are stated, not hidden", () => {
  const built = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF, suppressedCount: 2 });
  assert.match(
    built.submission.body,
    /◇ 2 findings suppressed after the sandbox could not reproduce them/,
  );
  assert.match(
    built.submission.body,
    /\| ◇ \| \*\*Execution Proof\*\* \| 2 findings discarded, the sandbox could not reproduce them \|/,
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
  // The summary paragraph sits straight under the block's own heading: a second
  // heading that says "Summary" under one that already does is noise.
  assert.match(body, /## ◈ Cavix Summary\n\nAdds a DB query during login\./);

  // The walkthrough: every changed file and what it now does, as bullets. No
  // line counts, no size column: GitHub prints those a few pixels away.
  assert.match(body, /### What Changed/);
  assert.match(body, /- \[`src\/auth\.js`\]\S+ · Look up the user during login$/m);
  // README.md has no walkthrough entry: the bullet still exists, described from
  // the diff, so a file can never vanish from the map because the model skipped it.
  assert.match(body, /- \[`README\.md`\]\S+ · In `# Project`$/m);
  assert.doesNotMatch(body, /\+\d+ \/ -\d+/, "no diff stats in the description");

  // The Scope module belongs to the review comment. Duplicating it here would
  // make a reader read the same table twice on one page.
  assert.doesNotMatch(body, /Review Scope & Effort/);
});

test("the description says nothing that a fix would make untrue", () => {
  // Everything about a finding goes stale the moment the author pushes the fix,
  // and the author cannot edit Cavix's block to correct it. So none of it is
  // allowed in the description: no verdict, no counts, no severity, no marks.
  const result = resultWith(
    finding({ severity: "critical" }),
    finding({ line: 13, severity: "high", title: "Token returned unchecked" }),
    finding({ path: "README.md", line: 2, severity: "low", title: "Stale wording" }),
  );
  result.walkthrough = [{ path: "src/auth.js", summary: "Look up the user during login" }];
  const body = buildPullDescription("Author notes.", result, DIFF, REF);
  const heading = "## ◈ Cavix Summary";
  const owned = body.slice(body.indexOf(heading) + heading.length);

  assert.doesNotMatch(owned, /> \[!/, "no verdict callout");
  assert.doesNotMatch(owned, /finding/i);
  assert.doesNotMatch(owned, /critical|high|medium|low|severity/i);
  assert.doesNotMatch(owned, /[◆◈◇▪▫⬢▲]/, "no severity marks either");
  assert.doesNotMatch(owned, /Fix these first|Findings|Pre-merge|Confidence/);
  // What it DOES say survives any number of fixes.
  assert.match(owned, /Adds a DB query during login\./);
  assert.match(owned, /- \[`src\/auth\.js`\]\S+ · Look up the user during login$/m);
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
  // The rules inside the block are section spacing between Summary and What
  // Changed. The one that must NOT be there is the separator that divides the
  // author's text from ours, when there is no author text to divide.
  assert.ok(body.startsWith(`${SUMMARY_START}\n## ◈ Cavix Summary\n`), "the title follows the marker directly");
});

// ── house style: no emoji, plain punctuation, everywhere ─────────────────────

test("nothing Cavix posts contains an emoji", () => {
  const loud = resultWith(
    finding({ verification: PROOF }),
    finding({ line: 13, severity: "critical", title: "Second issue" }),
    finding({ line: 999, severity: "low", title: "Off-diff note" }),
    finding({ path: "README.md", line: 2, severity: "info", category: "docs", title: "Stale wording" }),
  );
  loud.walkthrough = [{ path: "src/auth.js", summary: "Look up the user during login" }];

  const built = buildReviewSubmission(loud, DIFF, {
    ref: REF,
    includeSummary: true,
    suppressedCount: 1,
    requestChanges: true,
    preMerge: {
      checks: [
        { rule: "No console.log", detail: "2 files scanned", status: "pass", findings: [] },
        { rule: "No raw SQL", detail: "1 violation", status: "fail", findings: [] },
        { rule: "Something vague", detail: "Cavix could not run this check", status: "skipped", findings: [] },
      ],
      findings: [],
      passed: 1,
      failed: 1,
      skipped: 1,
    },
  });

  const surfaces = [
    buildPullDescription("Author notes.", loud, DIFF, REF),
    built.submission.body,
    ...built.submission.comments.map((c) => c.body),
  ];
  for (const surface of surfaces) {
    assert.doesNotMatch(surface, EMOJI, `an emoji survived into:\n${surface}`);
  }
});

test("plain: rewrites the typography a model reaches for", () => {
  assert.equal(plain("Refactors the refund flow — one verified issue."), "Refactors the refund flow, one verified issue.");
  assert.equal(plain("see lines 12–18"), "see lines 12-18");           // a range keeps a hyphen
  assert.equal(plain("the “quoted” ‘bit’"), 'the "quoted" \'bit\'');
  assert.equal(plain("and so on…"), "and so on...");
  assert.equal(plain("`+3 −1`"), "`+3 -1`");                            // unicode minus
  assert.equal(plain("no punctuation to fix"), "no punctuation to fix");
});

test("nothing Cavix posts contains an em or en dash, whatever the model wrote", () => {
  const dashed = resultWith(
    finding({
      title: "Token — returned unchecked",
      body: "The caller — which retries — never sees the failure, see lines 12–18.",
    }),
    finding({ line: 999, title: "Off-diff — also dashed", body: "Detail — lives in the dropdown." }),
  );
  dashed.summary = "Adds a login query — the hot path — without a guard.";
  dashed.walkthrough = [{ path: "src/auth.js", summary: "Look up the user — during login" }];

  const surfaces = [
    buildPullDescription("Author notes — kept as written.", dashed, DIFF, REF),
    ...(() => {
      const built = buildReviewSubmission(dashed, DIFF, { ref: REF, includeSummary: true });
      return [built.submission.body, ...built.submission.comments.map((c) => c.body)];
    })(),
  ];

  for (const surface of surfaces) {
    // The author's own words are the one exception: Cavix never edits those, and
    // they only appear in the description, outside the block Cavix owns.
    const cavixOwned = surface.includes(SUMMARY_START)
      ? surface.slice(surface.indexOf(SUMMARY_START))
      : surface;
    assert.doesNotMatch(cavixOwned, /[—–]/, `an em or en dash survived into:\n${cavixOwned}`);
  }
});

// ── the call-flow diagram (Stage 4, rendered as Mermaid) ─────────────────────

test("the diagram goes in the PR description, with the summary and walkthrough", () => {
  // It describes what the change DOES, which is still true after the author
  // fixes every finding. That is the rule the description block is built on, and
  // it is why the diagram belongs there rather than with the findings.
  const body = buildPullDescription("Author notes.", resultWith(finding()), DIFF, REF, ALL_SECTIONS, TRACE);
  assert.match(body, /### Call flow/);
  assert.match(body, /```mermaid\nsequenceDiagram/);
  assert.match(body, /login/, "the caption names what it was traced from");
  assert.ok(body.indexOf("### Call flow") < body.indexOf(SUMMARY_END), "inside the block Cavix owns");
});

test("the review comment carries no diagram while the description has one", () => {
  // Two copies of the same picture on one page is how a review starts feeling
  // like spam. The comment only gets it when the description could not be
  // written at all.
  const built = buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF, trace: TRACE });
  assert.doesNotMatch(built.submission.body, /```mermaid/);
});

test("a fork PR folds the diagram into the comment rather than losing it", () => {
  // includeSummary is what the workflow sets when it could not write the
  // description. The diagram degrades by the same path as the summary, with no
  // second code path to get wrong.
  const built = buildReviewSubmission(resultWith(finding()), DIFF, {
    ref: REF,
    includeSummary: true,
    trace: TRACE,
  });
  assert.match(built.submission.body, /### Call flow/);
  assert.match(built.submission.body, /```mermaid/);
});

test("the dashboard toggle actually removes it", () => {
  // This switch has existed in the settings page since it was written and the
  // orchestrator dropped the field on arrival, so it changed nothing. Off means
  // off now.
  const off = { ...ALL_SECTIONS, sequenceDiagram: false };
  const body = buildPullDescription("Author notes.", resultWith(finding()), DIFF, REF, off, TRACE);
  assert.doesNotMatch(body, /Call flow/);
  assert.doesNotMatch(body, /mermaid/);
  assert.match(body, /### What Changed/, "the rest of the block is untouched");
});

test("no trace means no section, not an empty one", () => {
  // The usual case: a single-file change, or a deployment with the deep path
  // off. An empty diagram reads as a broken feature.
  const body = buildPullDescription("Author notes.", resultWith(finding()), DIFF, REF, ALL_SECTIONS);
  assert.doesNotMatch(body, /Call flow/);
  assert.doesNotMatch(body, /mermaid/);
  assert.doesNotMatch(body, /```\s*```/, "and no stray fence is left behind");
});

test("the diagram obeys the house style like every other surface", () => {
  const hostile: CallTrace = {
    participants: ["src/naïve.js", "src/db.js"],
    steps: [{ fromPath: "src/naïve.js", fromSymbol: "go", toPath: "src/db.js", toSymbol: "run—now", line: 1 }],
    entryPoints: ["go"],
    truncated: true,
  };
  const surfaces = [
    buildPullDescription("Author notes.", resultWith(finding()), DIFF, REF, ALL_SECTIONS, hostile),
    buildReviewSubmission(resultWith(finding()), DIFF, { ref: REF, includeSummary: true, trace: hostile })
      .submission.body,
  ];
  for (const surface of surfaces) {
    assert.doesNotMatch(surface, EMOJI, "no emoji");
    const owned = surface.includes(SUMMARY_START) ? surface.slice(surface.indexOf(SUMMARY_START)) : surface;
    assert.doesNotMatch(owned, /[—–]/, "no em or en dashes");
  }
});
