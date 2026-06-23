import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import {
  Reviewer,
  FakeGitHubClient,
  InlineEngine,
  FakeStreamSource,
  makeReviewHandler,
  pumpOnce,
  runReview,
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
`;

// A deterministic "model" that finds the SQL injection on added line 12.
const responder = () =>
  JSON.stringify({
    summary: "Adds a DB lookup to login; the query is built by string concatenation.",
    findings: [
      {
        path: "src/auth.js",
        line: 12,
        severity: "high",
        category: "security",
        title: "SQL injection via string concatenation",
        body: "`user.id` is concatenated directly into the SQL string.",
        suggestion: 'db.query("SELECT * FROM u WHERE id = ?", [user.id]);',
        confidence: 0.93,
      },
    ],
  });

function makeJob(): ReviewJob {
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

function wire() {
  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "byok-acme", model: "claude-sonnet-4-6" } },
  };
  const gateway = new Gateway({ providers: new Map([["fake", new FakeProvider(responder)]]), config });
  const reviewer = new Reviewer({ gateway });
  const github = new FakeGitHubClient({ diff: DIFF });
  return { gateway, reviewer, github };
}

test("e2e: stream → bridge → engine → workflow → posted PR review", async () => {
  const { gateway, reviewer, github } = wire();

  // Stage 0 output: the edge XADDed this job; the source replays it.
  const source = new FakeStreamSource([{ id: "1700-0", job: JSON.stringify(makeJob()) }]);

  const engine = new InlineEngine();
  engine.registerWorker(makeReviewHandler({ github, reviewer }));

  const started = Date.now();
  const read = await pumpOnce(source, engine, { batch: 10, blockMs: 0 });
  const elapsedMs = Date.now() - started;

  // One job consumed and acked.
  assert.equal(read, 1);
  assert.deepEqual(source.acked, ["1700-0"]);

  // A review was posted to GitHub with the inline comment on the right line.
  assert.equal(github.submissions.length, 1);
  const review = github.lastReview()!;
  assert.equal(review.event, "COMMENT");
  assert.equal(review.comments.length, 1);
  assert.equal(review.comments[0].path, "src/auth.js");
  assert.equal(review.comments[0].line, 12);
  assert.match(review.comments[0].body, /SQL injection/);
  assert.match(review.body, /Cavix review/);

  // Cost accounting happened (Stage 13 seam).
  assert.equal(gateway.costLog().length, 1);
  assert.equal(gateway.costLog()[0].org, "acme");

  // Acceptance: well under the 60s budget (this is in-process, so milliseconds).
  assert.ok(elapsedMs < 60_000, `review took ${elapsedMs}ms, budget 60000ms`);
});

test("e2e: runReview returns a structured outcome with the posted url", async () => {
  const { reviewer, github } = wire();
  const outcome = await runReview(makeJob(), { github, reviewer });
  assert.equal(outcome.findingCount, 1);
  assert.equal(outcome.inlineCount, 1);
  assert.match(outcome.posted.htmlUrl, /pull\/42#pullrequestreview-/);
});

test("e2e: a clean diff posts a no-issues summary and no inline comments", async () => {
  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "byok-acme", model: "claude-sonnet-4-6" } },
  };
  const gateway = new Gateway({
    providers: new Map([["fake", new FakeProvider(() => JSON.stringify({ summary: "looks fine", findings: [] }))]]),
    config,
  });
  const github = new FakeGitHubClient({ diff: DIFF });
  const outcome = await runReview(makeJob(), { github, reviewer: new Reviewer({ gateway }) });
  assert.equal(outcome.findingCount, 0);
  assert.equal(outcome.inlineCount, 0);
  assert.match(github.lastReview()!.body, /No issues found/);
});
