import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import {
  ALL_SECTIONS,
  CHECK_NAME,
  FakeGitHubClient,
  makeReviewHandler,
  Reviewer,
  runReview,
  type OrgReviewConfig,
} from "@cavix/orchestrator";

// The Cavix row in the pull request's Checks box, next to CI.
//
// It is the first thing a reviewer sees, before there is any comment to read: a
// spinner the moment the job is picked up, then a tick with the outcome once the
// review is posted. These tests pin the whole lifecycle, because a check that
// opens and never closes leaves a pull request looking permanently stuck.

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

const FINDING = {
  path: "src/auth.js",
  line: 12,
  severity: "high",
  category: "security",
  title: "SQL injection via string concatenation",
  body: "`user.id` is concatenated directly into the SQL string.",
  confidence: 0.93,
};

function responder(findings: unknown[] = [FINDING]) {
  return () => JSON.stringify({ summary: "Adds a DB lookup on login.", effort: 2, findings });
}

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

function wire(findings?: unknown[], githubOpts: Record<string, unknown> = {}) {
  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "byok-acme", model: "claude-sonnet-4-6" } },
  };
  const gateway = new Gateway({ providers: new Map([["fake", new FakeProvider(responder(findings))]]), config });
  const github = new FakeGitHubClient({ diff: DIFF, ...githubOpts });
  return { github, reviewer: new Reviewer({ gateway }) };
}

function config(over: Partial<OrgReviewConfig> = {}): OrgReviewConfig {
  return {
    verifyFindings: false,
    summaryInDescription: true,
    requestChangesOnFail: false,
    failOn: ["critical"],
    preMergeChecks: { enabled: false, rules: [] },
    sections: ALL_SECTIONS,
    autoReview: true,
    reviewDraftPRs: true,
    tone: "concise",
    pathFilters: { include: [], exclude: [] },
    thresholdByCategory: {},
    verifyByCategory: {},
    ...over,
  };
}

test("the check opens as in progress and closes as completed, exactly once each", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), { github, reviewer });

  assert.equal(github.checkRuns.length, 2, "one open, one close, and no more");
  const [opened, closed] = github.checkRuns;

  assert.equal(opened.status, "in_progress");
  assert.equal(opened.conclusion, undefined, "an in-progress check has no conclusion yet");
  assert.match(opened.title, /Reviewing this pull request/);

  assert.equal(closed.status, "completed");
  assert.equal(closed.id, opened.id, "the same row is moved on, never a second one");
  assert.equal(outcome.checkRunId, opened.id);
});

test("the check opens BEFORE the review is posted, so the PR shows work in progress", async () => {
  const { github, reviewer } = wire();
  const order: string[] = [];
  const postReview = github.postReview.bind(github);
  github.postReview = async (ref, review) => {
    order.push("review");
    return postReview(ref, review);
  };
  const createCheckRun = github.createCheckRun.bind(github);
  github.createCheckRun = async (ref, input) => {
    order.push("check");
    return createCheckRun(ref, input);
  };

  await runReview(job(), { github, reviewer });
  assert.deepEqual(order, ["check", "review"]);
});

test("a review with findings still concludes success when the owner did not ask Cavix to block", async () => {
  const { github, reviewer } = wire();
  await runReview(job(), { github, reviewer });

  const done = github.lastCheckRun()!;
  assert.equal(done.conclusion, "success", "Cavix never gates a merge it was not invited to gate");
  assert.match(done.title, /^Review complete\. 1 finding, highest high$/);
  // The expanded view carries the same Scope module the review comment opens
  // with, so the two surfaces cannot disagree about what was scanned.
  assert.match(done.summary, /\| \| Signal \| Reading \|/);
  assert.match(done.summary, /\*\*Review Effort\*\*/);
  assert.match(done.summary, /◈ 1 high/);
  assert.match(done.summary, /listed in the Cavix review comment/);
});

test("a clean review says so on the check row", async () => {
  const { github, reviewer } = wire([]);
  await runReview(job(), { github, reviewer });

  const done = github.lastCheckRun()!;
  assert.equal(done.conclusion, "success");
  assert.equal(done.title, "Review complete. No issues found");
  assert.match(done.summary, /had nothing to raise/);
});

test("the check links to the review it summarises", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), { github, reviewer });
  assert.equal(github.lastCheckRun()!.detailsUrl, outcome.posted.htmlUrl);
});

test("the check fails only when the owner turned blocking on and something they nominated failed", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), {
    github,
    reviewer,
    reviewConfig: async () => config({ requestChangesOnFail: true, failOn: ["high", "critical"] }),
  });

  assert.equal(outcome.blocked, true);
  const done = github.lastCheckRun()!;
  assert.equal(done.conclusion, "failure", "this is the row an org marks required to gate a merge");
  assert.match(done.title, /^Changes requested: /);
});

test("a failed review leaves a neutral check, never a red one", async () => {
  // Cavix being unable to run is our problem. A red cross here would mean an
  // expired API key silently blocks every merge in the org, so the conclusion is
  // neutral, which GitHub counts as passing for a required check.
  const { github, reviewer } = wire();
  const broken = Object.create(github) as typeof github;
  broken.fetchPullDiff = async () => {
    throw new Error("github: fetch diff HTTP 404 Not Found");
  };

  await makeReviewHandler({ github: broken, reviewer, gate: async () => ({ enabled: true, org: "acme" }) })(job());

  const done = github.lastCheckRun()!;
  assert.equal(done.status, "completed");
  assert.equal(done.conclusion, "neutral");
  assert.equal(done.title, "Review could not be completed");
  assert.match(done.summary, /App may not be installed/, "and it says what to do about it");
  assert.doesNotMatch(done.summary, /Review complete/);
});

test("a repo that is toggled off gets no check row at all", async () => {
  const { github, reviewer } = wire();
  await makeReviewHandler({ github, reviewer, gate: async () => ({ enabled: false }) })(job());
  assert.equal(github.checkRuns.length, 0, "Cavix is not running here, so it claims no status");
  assert.equal(github.submissions.length, 0);
});

test("an install that cannot write checks still gets its review", async () => {
  // Check runs are a GitHub App feature needing `checks: write`. A deployment on
  // a personal access token gets a 403 and no row, and that must cost the status
  // line only, never the review.
  const { github, reviewer } = wire(undefined, { noChecks: true });
  const outcome = await runReview(job(), { github, reviewer });

  assert.equal(github.checkRuns.length, 0);
  assert.equal(outcome.checkRunId, 0);
  assert.equal(github.submissions.length, 1, "the review is on the pull request regardless");
  assert.equal(outcome.findingCount, 1);
});

test("a check-run API that throws never fails the review", async () => {
  const { github, reviewer } = wire();
  github.createCheckRun = async () => {
    throw new Error("github: create check run HTTP 500");
  };
  const outcome = await runReview(job(), { github, reviewer });
  assert.equal(outcome.checkRunId, 0);
  assert.equal(github.submissions.length, 1);
});

test("the check name is fixed, because branch protection matches it by name", () => {
  // Renaming this silently detaches every "required check" rule pointing at it,
  // which leaves a branch protected by a check that can never run again.
  assert.equal(CHECK_NAME, "Cavix Review");
});
