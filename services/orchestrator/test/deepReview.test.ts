import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import {
  FakeGitHubClient,
  makeDeepReviewStep,
  Reviewer,
  runReview,
  type DeepReviewStep,
} from "@cavix/orchestrator";
import { DEFAULT_REVIEW_CONFIG } from "../src/byok/reviewConfig.ts";

// Stages 3, 4, 7, 8 and 9 on a real pull request.
//
// These packages were written, tested and then never called by the running
// service, which reviewed every PR with one model and one prompt over the raw
// diff. The eval harness has scored the two paths side by side the whole time:
// 81.8% F1 for the single pass, 95.7% for the pipeline. This is the wiring that
// closes that gap, and these tests pin the two things that matter about it: the
// deep path really runs, and when it breaks the review still happens.

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

/**
 * The file as it exists at the head commit, padded so its line numbers match the
 * diff's: `db.query` sits on line 12 in both. That alignment is not cosmetic.
 * The deterministic scanners read this file and report absolute line numbers,
 * the agents read the diff and report new-file line numbers, and adjudication can
 * only recognise the two as the same defect if they agree on where it is.
 */
const HEAD_SOURCE = `import { sign } from "./jwt.js";
import { cache } from "./cache.js";
import { db } from "./db.js";

// Session helpers.

function issue(user) {
  return sign(user);
}

function login(user) {
  const token = sign(user);
  cache.set(user.id, token);
  db.query("SELECT * FROM u WHERE id = " + user.id);
  return token;
}

function handler(req) {
  return login(req.user);
}
`;

function job(): ReviewJob {
  return {
    schema_version: "1",
    idempotency_key: "idem-1",
    delivery_id: "d-1",
    org: "acme",
    repo: "acme/widget",
    repo_id: 1,
    pr_number: 42,
    action: "opened",
    head_sha: "headsha",
    base_sha: "basesha",
    installation_id: 9,
    priority: 100,
    title: "Add DB lookup on login",
    author: "octocat",
    enqueued_at: "2026-06-23T00:00:00Z",
  };
}

/**
 * A provider that answers every prompt shape the review path can send: the seven
 * agent prompts, the summary-only prompt, and the old single-model prompt. It
 * records which it saw, so a test can tell the two paths apart.
 */
function wire() {
  const systems: string[] = [];
  const provider = new FakeProvider((req) => {
    const system = req.system ?? "";
    systems.push(system);

    if (system.includes("Describe a pull request")) {
      return JSON.stringify({
        summary: "Adds a DB lookup during login.",
        walkthrough: [{ path: "src/auth.js", summary: "Look up the user during login" }],
        effort: 3,
      });
    }
    // An agent prompt. Match the exact marker, not the word "security": the
    // single-model prompt lists security too, and a loose match here made this
    // test pass against the wrong code path.
    if (system.includes(`Cavix "security" review agent`)) {
      return JSON.stringify({
        abstain: false,
        findings: [
          {
            path: "src/auth.js",
            line: 12,
            severity: "high",
            category: "security",
            title: "SQL injection via string concatenation",
            body: "user.id is concatenated into SQL.",
            confidence: 0.9,
          },
        ],
      });
    }
    if (system.includes("review agent")) return JSON.stringify({ abstain: true, findings: [] });

    if (system.includes("Cavix, a precise code reviewer")) {
      // The single-model fallback path.
      return JSON.stringify({
        summary: "Single-model summary.",
        effort: 2,
        findings: [
          {
            path: "src/auth.js",
            line: 12,
            severity: "medium",
            category: "correctness",
            title: "Fallback finding",
            body: "from the single pass",
            confidence: 0.6,
          },
        ],
      });
    }
    return JSON.stringify({ findings: [] });
  });

  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "byok-acme", model: "claude-sonnet-4-6" } },
  };
  const gateway = new Gateway({ providers: new Map([["fake", provider]]), config });
  const github = new FakeGitHubClient({ diff: DIFF, files: { "src/auth.js": HEAD_SOURCE } });
  const reviewer = new Reviewer({ gateway });
  const deepReview = makeDeepReviewStep({ gateway, github });
  return { github, reviewer, gateway, deepReview, systems };
}

test("the deep path runs the ensemble and the summariser, not the single-model prompt", async () => {
  const { github, reviewer, deepReview, systems } = wire();
  const outcome = await runReview(job(), { github, reviewer, deepReview });

  assert.ok(
    systems.some((s) => s.includes("Describe a pull request")),
    "the prose comes from its own cheap pass",
  );
  assert.ok(systems.filter((s) => s.includes("review agent")).length === 7, "the specialists ran in parallel");
  assert.ok(
    !systems.some((s) => s.includes("Cavix, a precise code reviewer")),
    "the old single-model prompt is not also sent, which would be paying twice",
  );
  // Stage 3's SAST rule and Stage 8's security agent both found the same defect
  // on the same line. Stage 9 merged them into ONE comment rather than posting
  // the same problem twice, which is the whole reason adjudication exists.
  assert.equal(outcome.findingCount, 1, "two sources, one finding");
  assert.match(github.lastReview()!.body, /SQL built by string concatenation/);
  assert.match(github.pullBody, /Adds a DB lookup during login\./, "the summary still reaches the description");
});

test("the deep path's real measurements reach the Scope module", async () => {
  // The AST, Deterministic Pass and Ensemble rows exist for exactly this. They
  // are absent on the single-model path because there is nothing to count, and
  // the module never fills a row it has no measurement for.
  const { github, reviewer, deepReview } = wire();
  await runReview(job(), { github, reviewer, deepReview });
  const body = github.lastReview()!.body;

  assert.match(body, /\*\*AST Verification\*\* \| \d+ symbols? resolved, cross-file impact mapped/);
  assert.match(body, /\*\*Deterministic Pass\*\* \| \d+ linter, SAST and secret tools? run over the change/);
  assert.match(body, /\*\*Ensemble\*\* \| \d+ specialist agents? read this diff independently/);
});

test("the single-model path claims none of those stages", async () => {
  const { github, reviewer } = wire();
  await runReview(job(), { github, reviewer }); // no deepReview dep
  const body = github.lastReview()!.body;

  assert.doesNotMatch(body, /AST Verification/);
  assert.doesNotMatch(body, /Deterministic Pass/);
  assert.doesNotMatch(body, /Ensemble/);
  assert.match(body, /Fallback finding/, "and the review still happens");
});

test("a broken deep path falls back to the single pass instead of failing the review", async () => {
  const { github, reviewer, systems } = wire();
  const broken: DeepReviewStep = async () => {
    throw new Error("index build blew up");
  };

  const outcome = await runReview(job(), { github, reviewer, deepReview: broken });

  assert.equal(github.submissions.length, 1, "the customer still gets their review");
  assert.equal(outcome.findingCount, 1);
  assert.match(github.lastReview()!.body, /Fallback finding/);
  assert.ok(
    systems.some((s) => s.includes("Cavix, a precise code reviewer")),
    "the single-model prompt is what produced it",
  );
});

test("a deep review that cannot read the changed files fails soft, not loud", async () => {
  // fetchSources returns nothing when the contents API has nothing for us: a
  // fork, a permission gap, a binary-only change. The step throws, and the
  // workflow's fallback is what the customer actually experiences.
  const { reviewer, gateway } = wire();
  const empty = new FakeGitHubClient({ diff: DIFF }); // no files map
  const deepReview = makeDeepReviewStep({ gateway, github: empty });

  await assert.rejects(
    () => deepReview({ org: "acme", title: "t", diff: DIFF, ref: { owner: "acme", repo: "widget", number: 42, headSha: "h", installationId: 9 } }),
    /could not read any of the changed files/,
  );

  const outcome = await runReview(job(), { github: empty, reviewer, deepReview });
  assert.equal(outcome.findingCount, 1, "and the review lands anyway");
});

test("a wide pull request still gets the ensemble, and does not claim a full scan", async () => {
  // Refusing outright was the first behaviour here, and it meant any PR touching
  // more than the file budget fell all the way back to one model over the raw
  // diff. That is most real pull requests. The agents read the DIFF, so they lose
  // nothing; only the graph and the scanners see less, and the review must not
  // then claim they saw everything.
  const wide = Array.from(
    { length: 20 },
    (_, i) => `diff --git a/src/f${i}.js b/src/f${i}.js\n--- a/src/f${i}.js\n+++ b/src/f${i}.js\n@@ -1,1 +1,2 @@ function f${i}() {\n const a = 1;\n+const b = ${i};\n`,
  ).join("");

  const files: Record<string, string> = {};
  for (let i = 0; i < 20; i++) files[`src/f${i}.js`] = `function f${i}() {\n const a = 1;\n const b = ${i};\n}\n`;

  const { reviewer, gateway } = wire();
  const github = new FakeGitHubClient({ diff: wide, files });
  const deepReview = makeDeepReviewStep({ gateway, github });

  await runReview({ ...job(), title: "Wide change" }, { github, reviewer, deepReview });
  const body = github.lastReview()!.body;

  assert.match(body, /\*\*Ensemble\*\*/, "the seven agents still ran");
  assert.match(body, /\*\*AST Verification\*\*/, "and the graph covered what it could read");
  assert.doesNotMatch(
    body,
    /Deterministic Pass/,
    "but the scanners saw part of the change, so that row is withheld rather than overstated",
  );
});

test("summary mode never pays for the ensemble", async () => {
  // Nobody typing "@cavixcode summary" wants seven agents billed to produce a
  // paragraph, so the deep path is skipped for that mode entirely.
  const { github, reviewer, deepReview, systems } = wire();
  await runReview(job(), { github, reviewer, deepReview }, { mode: "summary" });

  assert.equal(github.submissions.length, 0);
  assert.ok(!systems.some((s) => s.includes("review agent")), "no agent ran");
  assert.match(github.pullBody, /Adds a DB lookup during login\./);
});

// ── Stage 12: the workspace's learned bar reaches Stage 9 ────────────────────

/**
 * A review config fetcher that counts its calls, so a test can prove the
 * calibration rides along on the fetch the workflow already makes rather than
 * adding a control-plane hop to every pull request.
 */
function configFetcher(thresholdByCategory: Record<string, number>) {
  const calls: string[] = [];
  const fetcher = async (org: string) => {
    calls.push(org);
    return { ...DEFAULT_REVIEW_CONFIG, verifyFindings: false, thresholdByCategory };
  };
  return { fetcher, calls };
}

/**
 * A change no deterministic scanner has an opinion about, reviewed by an
 * ensemble whose "correctness" agent reports one finding at 0.90.
 *
 * It has to be a finding NO scanner also found, because a cluster containing a
 * deterministic finding is immune to thresholding by construction. That is the
 * right behaviour and the test below pins it, but it makes the SQL-injection
 * fixture above useless for demonstrating that a learned bar does anything.
 */
function llmOnly() {
  const diff = `diff --git a/src/total.js b/src/total.js
--- a/src/total.js
+++ b/src/total.js
@@ -1,3 +1,4 @@ function total(items) {
   let sum = 0;
+  for (let i = 0; i <= items.length; i++) sum += items[i];
   return sum;
 }
`;
  const source = `function total(items) {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) sum += items[i];
  return sum;
}
`;
  const provider = new FakeProvider((req) => {
    const system = req.system ?? "";
    if (system.includes("Describe a pull request")) {
      return JSON.stringify({ summary: "Sums the items.", walkthrough: [], effort: 1 });
    }
    if (system.includes(`Cavix "correctness" review agent`)) {
      return JSON.stringify({
        abstain: false,
        findings: [
          {
            path: "src/total.js",
            line: 3,
            severity: "medium",
            category: "correctness",
            title: "Loop runs one past the end of the array",
            body: "`<=` should be `<`.",
            confidence: 0.9,
          },
        ],
      });
    }
    if (system.includes("review agent")) return JSON.stringify({ abstain: true, findings: [] });
    return JSON.stringify({ summary: "s", effort: 1, findings: [] });
  });

  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "byok-acme", model: "claude-sonnet-4-6" } },
  };
  const gateway = new Gateway({ providers: new Map([["fake", provider]]), config });
  const github = new FakeGitHubClient({ diff, files: { "src/total.js": source } });
  return {
    github,
    reviewer: new Reviewer({ gateway }),
    deepReview: makeDeepReviewStep({ gateway, github }),
  };
}

test("a learned bar suppresses a finding this workspace keeps rejecting", async () => {
  const { github, reviewer, deepReview } = llmOnly();
  // The correctness agent reports at 0.90. A workspace that has taught Cavix a
  // 0.95 bar for correctness should not be shown it.
  const { fetcher, calls } = configFetcher({ correctness: 0.95 });

  const outcome = await runReview(job(), { github, reviewer, deepReview, reviewConfig: fetcher });

  assert.equal(outcome.findingCount, 0, "held to the workspace's own bar");
  assert.equal(calls.length, 1, "and it cost exactly the config fetch the review already made");
});

test("the same finding survives with no calibration, so the bar is what changed", async () => {
  const { github, reviewer, deepReview } = llmOnly();
  const { fetcher } = configFetcher({});
  const outcome = await runReview(job(), { github, reviewer, deepReview, reviewConfig: fetcher });
  assert.equal(outcome.findingCount, 1);
});

test("a learned bar for another category leaves this one alone", async () => {
  const { github, reviewer, deepReview } = llmOnly();
  const { fetcher } = configFetcher({ style: 0.95 });
  const outcome = await runReview(job(), { github, reviewer, deepReview, reviewConfig: fetcher });
  assert.equal(outcome.findingCount, 1, "correctness is not held to style's bar");
});

test("a learned bar cannot suppress what a scanner also measured", async () => {
  // The SQL injection fixture: Stage 3's SAST rule and Stage 8's security agent
  // both found it, so the cluster is deterministic. No learned threshold, and no
  // number of rejections, can take a measured fact off the pull request.
  const { github, reviewer, deepReview } = wire();
  const { fetcher } = configFetcher({ security: 0.99 });
  const outcome = await runReview(job(), { github, reviewer, deepReview, reviewConfig: fetcher });
  assert.equal(outcome.findingCount, 1, "the scanner's fact survives the workspace's own bar");
});

test("no control-plane means no calibration, and the review is unaffected", async () => {
  // Every self-hosted deployment without a dashboard runs this path, and it is
  // also what a control-plane outage looks like. Stage 9 falls back to its own
  // default rather than to a bar of zero or a failed review.
  const { github, reviewer, deepReview } = llmOnly();
  const outcome = await runReview(job(), { github, reviewer, deepReview });
  assert.equal(outcome.findingCount, 1);
});
