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

test("summary mode never pays for the ensemble", async () => {
  // Nobody typing "@cavixcode summary" wants seven agents billed to produce a
  // paragraph, so the deep path is skipped for that mode entirely.
  const { github, reviewer, deepReview, systems } = wire();
  await runReview(job(), { github, reviewer, deepReview }, { mode: "summary" });

  assert.equal(github.submissions.length, 0);
  assert.ok(!systems.some((s) => s.includes("review agent")), "no agent ran");
  assert.match(github.pullBody, /Adds a DB lookup during login\./);
});
