import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import {
  Reviewer,
  FakeGitHubClient,
  type GitHubClient,
  InlineEngine,
  FakeStreamSource,
  makeReviewHandler,
  pumpOnce,
  runReview,
  isPermanentFailure,
  cleanUp,
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

test("gatekeeper: a repo toggled OFF is skipped — no review is posted", async () => {
  const { github, reviewer } = wire();
  const handler = makeReviewHandler({ github, reviewer, gate: async () => ({ enabled: false }) });
  await handler(makeJob());
  assert.equal(github.submissions.length, 0, "disabled repo must not be reviewed");
});

test("gatekeeper: a repo toggled ON is reviewed and posted", async () => {
  const { github, reviewer } = wire();
  let gatedRepo = "";
  const handler = makeReviewHandler({
    github,
    reviewer,
    gate: async (full) => { gatedRepo = full; return { enabled: true }; },
  });
  await handler(makeJob());
  assert.equal(gatedRepo, "acme/widget", "gate is asked about the PR's repo");
  assert.equal(github.submissions.length, 1);
});

// ---- "@cavixcode review" (command jobs) ----
//
// These cover the exact path that used to fail silently end-to-end: a comment
// command carries no head SHA, and nothing ever acknowledged the comment.

function makeCommandJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    ...makeJob(),
    action: "command",
    head_sha: "", // issue_comment payloads have no commit — this is the point
    trigger: "command",
    command: "review",
    comment_id: 777,
    author_association: "OWNER",
    force_fresh: true,
    ...overrides,
  };
}

test("command job: head SHA is resolved from the PR before posting", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(makeCommandJob(), { github, reviewer });
  assert.equal(outcome.findingCount, 1);
  // The submission must carry the resolved commit, never an empty string (422).
  assert.equal(github.submissions[0].ref.headSha, "resolvedheadsha");
});

test("command job: reacts with eyes on pickup and rocket when the review lands", async () => {
  const { github, reviewer } = wire();
  const handler = makeReviewHandler({ github, reviewer, gate: async () => ({ enabled: true }) });
  await handler(makeCommandJob());

  assert.deepEqual(
    github.reactions.map((r) => r.content),
    ["eyes", "rocket"],
    "the human sees 👀 immediately, then 🚀 when the review is posted",
  );
  assert.equal(github.reactions[0].commentId, 777, "reacts to the triggering comment");
  assert.equal(github.submissions.length, 1);
});

test("command job: a disabled repo gets 👍 and a comment telling you how to enable it", async () => {
  const { github, reviewer } = wire();
  const handler = makeReviewHandler({ github, reviewer, gate: async () => ({ enabled: false }) });
  await handler(makeCommandJob());

  assert.deepEqual(github.reactions.map((r) => r.content), ["eyes", "+1"]);
  assert.equal(github.submissions.length, 0);
  assert.match(github.comments[0], /not enabled/i);
  assert.match(github.comments[0], /Repositories/);
});

/** The fake, with one call swapped out for a failing one. */
function withFailure(github: FakeGitHubClient, fail: () => never): GitHubClient {
  return {
    fetchPullDiff: async () => fail(),
    getPull: (ref) => github.getPull(ref),
    postReview: (ref, review) => github.postReview(ref, review),
    addReaction: (ref, id, content) => github.addReaction(ref, id, content),
    createComment: (ref, body) => github.createComment(ref, body),
    findComment: (ref, marker) => github.findComment(ref, marker),
    updateComment: (ref, id, body) => github.updateComment(ref, id, body),
    whoAmI: () => github.whoAmI(),
  };
}

test("command job: a failure reacts 😕 and explains the cause in a comment", async () => {
  const { github, reviewer } = wire();
  // Delegate everything to the fake except the diff fetch, which fails the way a
  // missing App installation does.
  const broken: GitHubClient = {
    fetchPullDiff: async () => { throw new Error("github: fetch diff HTTP 404 Not Found"); },
    getPull: (ref) => github.getPull(ref),
    postReview: (ref, review) => github.postReview(ref, review),
    addReaction: (ref, id, content) => github.addReaction(ref, id, content),
    createComment: (ref, body) => github.createComment(ref, body),
    findComment: (ref, marker) => github.findComment(ref, marker),
    updateComment: (ref, id, body) => github.updateComment(ref, id, body),
    whoAmI: () => github.whoAmI(),
  };
  const handler = makeReviewHandler({ github: broken, reviewer, gate: async () => ({ enabled: true }) });

  // A 404 is permanent, so the handler reports and returns instead of throwing —
  // rethrowing would make the queue retry a call that can never succeed.
  await handler(makeCommandJob());
  assert.deepEqual(github.reactions.map((r) => r.content), ["eyes", "confused"]);
  assert.match(github.comments[0], /could not finish/i);
  assert.match(github.comments[0], /may not be installed on this repository/i);
});

test("command job: BYOK uses the dashboard workspace from the gate, not the GitHub login", async () => {
  const config: GatewayConfigData = {
    // The key lives under the Cavix workspace name "acme-workspace"; the job's
    // org is the GitHub owner login "acme". Only the gate knows the mapping.
    orgs: { "acme-workspace": { provider: "fake", apiKey: "byok-acme", model: "claude-opus-5" } },
  };
  const gateway = new Gateway({ providers: new Map([["fake", new FakeProvider(responder)]]), config });
  const github = new FakeGitHubClient({ diff: DIFF });
  const handler = makeReviewHandler({
    github,
    reviewer: new Reviewer({ gateway }),
    gate: async () => ({ enabled: true, org: "acme-workspace" }),
  });

  await handler(makeCommandJob());
  assert.equal(github.submissions.length, 1);
  assert.equal(gateway.costLog()[0].org, "acme-workspace", "cost is attributed to the workspace");
});

// ---- retry behaviour: the "three identical comments" bug ----
//
// The queue runs a failed job three times. The handler used to create a comment
// on every attempt, so one "@cavixcode review" produced three identical failure
// comments on the PR.

test("a permanent failure is reported ONCE and never retried", async () => {
  const { github, reviewer } = wire();
  let attempts = 0;
  const broken = withFailure(github, () => {
    attempts++;
    throw new Error('google: HTTP 429 : {"error":{"code":429,"message":"You exceeded your current quota"}}');
  });
  const handler = makeReviewHandler({ github: broken, reviewer, gate: async () => ({ enabled: true }) });

  // The queue would call the handler again only if it threw.
  await handler(makeCommandJob());

  assert.equal(attempts, 1, "a doomed call must not be repeated");
  assert.equal(github.comments.length, 1, "exactly one comment, not three");
  assert.match(github.comments[0], /quota/i);
});

test("even if the queue does retry, the status comment is EDITED, not duplicated", async () => {
  const { github, reviewer } = wire();
  const broken = withFailure(github, () => { throw new Error("boom: upstream HTTP 503"); });
  const handler = makeReviewHandler({ github: broken, reviewer, gate: async () => ({ enabled: true }) });

  // 503 is transient, so the handler rethrows and the queue retries: simulate all
  // three attempts the way BullMQ would.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => handler(makeCommandJob()));
  }

  assert.equal(github.comments.length, 1, "one status comment on the PR, however many attempts ran");
  assert.equal(github.commentEdits, 2, "the later attempts edited it in place");
});

test("the status comment carries a hidden marker so it can be found again", async () => {
  const { github, reviewer } = wire();
  const broken = withFailure(github, () => { throw new Error("github: HTTP 404 Not Found"); });
  await makeReviewHandler({ github: broken, reviewer, gate: async () => ({ enabled: true }) })(makeCommandJob());
  assert.match(github.comments[0], /^<!-- cavix:status -->/);
});

test("transient failures still retry", () => {
  assert.equal(isPermanentFailure("upstream HTTP 503"), false);
  assert.equal(isPermanentFailure("socket hang up"), false);
  assert.equal(isPermanentFailure("ETIMEDOUT"), false);
});

test("permanent failures are recognised", () => {
  for (const m of [
    'google: HTTP 429 : {"error":{"message":"quota"}}',
    'provider "mistral" is not available',
    "anthropic: BYOK api key is empty",
    "github: fetch diff HTTP 404 Not Found",
    "github: post review HTTP 403 Forbidden",
    "google: HTTP 400 : API_KEY_INVALID",
  ]) {
    assert.equal(isPermanentFailure(m), true, `should be permanent: ${m}`);
  }
});

// The raw provider error is a wall of JSON; the PR should show the sentence.
test("cleanUp lifts the human message out of a provider's JSON error", () => {
  const raw = 'google: HTTP 429 : {\n "error": {\n "code": 429,\n "message": "You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 0"\n }\n}';
  const out = cleanUp(raw);
  assert.match(out, /google: HTTP 429/);
  assert.match(out, /You exceeded your current quota/);
  assert.ok(!out.includes('"code"'), "the JSON scaffolding should be gone");
});

test('a "limit: 0" quota error says waiting will not help', async () => {
  const { github, reviewer } = wire();
  const broken = withFailure(github, () => {
    throw new Error('google: HTTP 429 : {"error":{"message":"Quota exceeded for metric: x, limit: 0, model: gemini-2.0-flash"}}');
  });
  await makeReviewHandler({ github: broken, reviewer, gate: async () => ({ enabled: true }) })(makeCommandJob());
  assert.match(github.comments[0], /no quota for this model/i);
  assert.match(github.comments[0], /billing|switch to a model/i);
});
