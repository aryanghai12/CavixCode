import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import { EMPTY_LEDGER, type PrLedger } from "@cavix/review-session";
import {
  Reviewer,
  FakeGitHubClient,
  makeReviewHandler,
  runReview,
  type LedgerClient,
  type LedgerRef,
} from "@cavix/orchestrator";

// The reported bug, end to end.
//
// "I push a fix for one of the suggestions Cavix made, it re-reviews, and it
// gives me a green pass for merging even though the other suggestions are still
// there." Everything below is that sequence, driven through the real workflow.

// Two files. The author will fix the one in auth.js and never touch billing.js,
// which is what makes the second finding provably still open.
const HEAD_1 = `diff --git a/src/auth.js b/src/auth.js
--- a/src/auth.js
+++ b/src/auth.js
@@ -10,3 +10,5 @@ function login(user) {
   const token = sign(user);
+  db.query("SELECT * FROM u WHERE id = " + user.id);
+  return token;
 }
diff --git a/src/billing.js b/src/billing.js
--- a/src/billing.js
+++ b/src/billing.js
@@ -4,2 +4,5 @@ function refund(cents) {
   return gateway.charge(cents);
 }
+function credit(cents) {
+  return gateway.charge(cents);
+}
`;

// After the push: auth.js is parameterised, billing.js is byte-identical.
const HEAD_2 = `diff --git a/src/auth.js b/src/auth.js
--- a/src/auth.js
+++ b/src/auth.js
@@ -10,3 +10,5 @@ function login(user) {
   const token = sign(user);
+  db.query("SELECT * FROM u WHERE id = ?", [user.id]);
+  return token;
 }
diff --git a/src/billing.js b/src/billing.js
--- a/src/billing.js
+++ b/src/billing.js
@@ -4,2 +4,5 @@ function refund(cents) {
   return gateway.charge(cents);
 }
+function credit(cents) {
+  return gateway.charge(cents);
+}
`;

const SQLI = {
  path: "src/auth.js",
  line: 12,
  severity: "critical",
  category: "security",
  title: "SQL injection via string concatenation",
  body: "`user.id` is concatenated into the SQL string.",
  confidence: 0.95,
};

const BILLING = {
  path: "src/billing.js",
  line: 7,
  severity: "critical",
  category: "correctness",
  title: "credit charges the customer instead of crediting them",
  body: "`credit` calls `gateway.charge`.",
  confidence: 0.92,
};

function model(findings: unknown[]) {
  return () => JSON.stringify({ summary: "A change to login and billing.", findings });
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

/** An in-memory control-plane for the ledger. Nothing here needs a network. */
function fakeLedger(): LedgerClient & { state: PrLedger; reads: number; writes: number; fail?: boolean } {
  const it = {
    state: EMPTY_LEDGER as PrLedger,
    reads: 0,
    writes: 0,
    fail: false,
    async fetch(_ref: LedgerRef) {
      it.reads++;
      if (it.fail) return { ledger: EMPTY_LEDGER, known: false };
      return { ledger: it.state, known: true };
    },
    async save(_ref: LedgerRef, ledger: PrLedger) {
      it.writes++;
      if (it.fail) return false;
      it.state = ledger;
      return true;
    },
  };
  return it;
}

function wire(findings: unknown[], diff: string) {
  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "byok-acme", model: "claude-sonnet-4-6" } },
  };
  const gateway = new Gateway({
    providers: new Map([["fake", new FakeProvider(model(findings))]]),
    config,
  });
  return {
    reviewer: new Reviewer({ gateway }),
    github: new FakeGitHubClient({ diff }),
  };
}

// The org must have blocking switched on for the check to be able to fail at
// all: Cavix never decides to block a team's merges on its own.
const BLOCKING = async () => ({
  verifyFindings: false,
  summaryInDescription: false,
  requestChangesOnFail: true,
  failOn: ["critical"],
  preMergeChecks: { enabled: false, rules: [] },
  sections: {
    summary: true,
    changedFiles: true,
    sequenceDiagram: true,
    reviewEffort: true,
    inlineFindings: true,
    proof: true,
  },
  autoReview: true,
  reviewDraftPRs: false,
  tone: "concise",
  pathFilters: { include: [], exclude: [] },
  thresholdByCategory: {},
  verifyByCategory: {},
});

test("the reported bug: fixing ONE of two findings does not hand out a green pass", async () => {
  const ledger = fakeLedger();

  // Review 1: both findings raised, the check fails, the merge is held.
  {
    const { reviewer, github } = wire([SQLI, BILLING], HEAD_1);
    const out = await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });
    assert.equal(out.findingCount, 2);
    assert.equal(out.blocked, true);
    assert.equal(github.lastCheckRun()?.conclusion, "failure");
  }

  // The author fixes the SQL injection and pushes. The model, reading a diff
  // that no longer contains the concatenation, reports only what it still sees
  // in auth.js — which is nothing. It says nothing about billing.js either,
  // because a model is not a function and this is the run where it goes quiet.
  //
  // Before the ledger, this review posted "Clean pass", closed the check green
  // and unlocked the merge button with a critical finding still on the page.
  const { reviewer, github } = wire([], HEAD_2);
  const out = await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });

  // The billing finding is carried: its file has not changed since it was
  // raised, so the reviewer's silence is not evidence of anything.
  assert.equal(out.carriedCount, 1);
  // The SQL injection IS cleared: that file did change, and the reviewer looked
  // at the new version and had nothing to say.
  assert.equal(out.resolvedCount, 1);

  // The verdict, which is the whole point.
  assert.equal(out.blocked, true, "a carried critical finding must still hold the merge");
  assert.equal(github.lastCheckRun()?.conclusion, "failure");
  // And the check names WHERE the block came from. "a finding was posted" would
  // send the reader hunting through a review that contains no findings at all.
  assert.match(
    github.lastCheckRun()?.title ?? "",
    /from earlier reviews is still open/,
    "the check must say the block comes from an earlier review, not this one",
  );

  // And the pull request says so in words, rather than leaving the reader to
  // infer it from a red check.
  const body = github.lastReview()?.body ?? "";
  assert.match(body, /Still open from earlier reviews/);
  assert.match(body, /credit charges the customer/);
  assert.doesNotMatch(body, /Clean pass/);

  // The fix is acknowledged too. A reviewer that only ever lists what is still
  // wrong is one people stop reading.
  assert.match(body, /Cleared by this push/);
  assert.match(body, /SQL injection/);
});

test("a carried finding clears once the code it points at is actually fixed", async () => {
  const ledger = fakeLedger();
  {
    const { reviewer, github } = wire([SQLI, BILLING], HEAD_1);
    await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });
  }
  {
    const { reviewer, github } = wire([], HEAD_2);
    const out = await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });
    assert.equal(out.carriedCount, 1);
    assert.equal(out.blocked, true);
  }

  // Now billing.js is fixed too, and the reviewer still says nothing.
  const FIXED = HEAD_2.replace(
    "+function credit(cents) {\n+  return gateway.charge(cents);\n+}",
    "+function credit(cents) {\n+  return gateway.refund(cents);\n+}",
  );
  const { reviewer, github } = wire([], FIXED);
  const out = await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });

  assert.equal(out.carriedCount, 0);
  assert.equal(out.resolvedCount, 1);
  assert.equal(out.blocked, false, "nothing is open, so nothing holds the merge");
  assert.equal(github.lastCheckRun()?.conclusion, "success");
  assert.match(github.lastReview()?.body ?? "", /Clean pass/);
});

test("a finding raised again on every push is not duplicated, and keeps blocking", async () => {
  const ledger = fakeLedger();
  for (let push = 1; push <= 3; push++) {
    const { reviewer, github } = wire([BILLING], HEAD_1);
    const out = await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });
    assert.equal(out.findingCount, 1, `push ${push}`);
    assert.equal(out.carriedCount, 0, `push ${push}: it was re-reported, so it is not carried`);
    assert.equal(out.blocked, true, `push ${push}`);
  }
  assert.equal(ledger.state.entries.length, 1, "one defect, one entry, three reviews");
  assert.equal(ledger.state.entries[0].timesReported, 3);
  assert.equal(ledger.state.reviewsUsed, 3);
});

test("an unreachable ledger degrades to the old behaviour and never to a green claim", async () => {
  const ledger = fakeLedger();
  {
    const { reviewer, github } = wire([BILLING], HEAD_1);
    await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });
  }

  // The control-plane goes down before the next push.
  ledger.fail = true;
  const { reviewer, github } = wire([], HEAD_2);
  const out = await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });

  // Nothing is carried, because nothing could be read. The review still posts:
  // a control-plane outage costs the customer their carried findings, never
  // their review.
  assert.equal(out.carriedCount, 0);
  assert.equal(github.submissions.length, 1);

  // But it does NOT claim a clean pass, because it does not know that it is one.
  const body = github.lastReview()?.body ?? "";
  assert.doesNotMatch(body, /Clean pass/);
  assert.match(body, /could not reach its record of earlier reviews/);
});

test("a failed ledger read must not overwrite what is stored", async () => {
  // The nastiest failure this design can have, and it is one line away at all
  // times. A failed read hands back an EMPTY ledger, because that is the only
  // honest answer to "what came before". Folding this review into that empty
  // prior and SAVING it would replace a ledger holding an open critical with one
  // holding nothing, and reset the review counter with it: a single
  // control-plane blip would clear every open finding on the pull request and
  // hand out exactly the green pass this feature exists to prevent.
  const ledger = fakeLedger();
  {
    const { reviewer, github } = wire([BILLING], HEAD_1);
    await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });
  }
  const stored = structuredClone(ledger.state);
  assert.equal(stored.entries.filter((e) => e.state === "open").length, 1);

  // The control-plane goes down. The review still runs and still posts.
  ledger.fail = true;
  const { reviewer, github } = wire([], HEAD_2);
  await runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING });
  assert.equal(github.submissions.length, 1, "the review still posts");

  // Nothing was written at all, so the open finding survives untouched.
  ledger.fail = false;
  assert.deepEqual(ledger.state, stored, "a failed read must leave the ledger exactly as it was");

  // And the next review that CAN reach the control-plane picks it up intact and
  // carries it, so the outage cost one review's memory and nothing permanent.
  const back = wire([], HEAD_2);
  const out = await runReview(job(), { github: back.github, reviewer: back.reviewer, ledger, reviewConfig: BLOCKING });
  assert.equal(out.carriedCount, 1);
  assert.equal(out.blocked, true);
});

test("with no control-plane at all, a clean review still reads as a clean pass", async () => {
  // A deployment with no ledger has no cross-review memory BY CONFIGURATION, and
  // a review there is as complete a statement as it can make. The hedged wording
  // above is for a deployment that has a ledger and could not reach it, which is
  // a different situation and the only one that warrants a caveat.
  const { reviewer, github } = wire([], HEAD_2);
  const out = await runReview(job(), { github, reviewer, reviewConfig: BLOCKING });
  assert.equal(out.carriedCount, 0);
  assert.match(github.lastReview()?.body ?? "", /Clean pass/);
});

test("the ledger is written only after the review is actually posted", async () => {
  const ledger = fakeLedger();
  const { reviewer, github } = wire([BILLING], HEAD_1);
  github.failPostReview = true;

  await assert.rejects(() => runReview(job(), { github, reviewer, ledger, reviewConfig: BLOCKING }));

  // Nothing was charged to the pull request's budget for a review nobody got.
  assert.equal(ledger.writes, 0);
  assert.equal(ledger.state.reviewsUsed, 0);
});

test("a pull request that has spent its reviews is left exactly as it was", async () => {
  const { reviewer, github } = wire([BILLING], HEAD_1);
  const handler = makeReviewHandler({
    github,
    reviewer,
    reviewConfig: BLOCKING,
    gate: async () => ({
      enabled: false,
      org: "acme",
      capReached: true,
      reason: "This pull request has used all 10 of its Cavix reviews.",
    }),
  });

  await handler(job());

  // No review, and no model call.
  assert.equal(github.submissions.length, 0);
  // Above all: the check run is untouched. Not created, not closed, not turned
  // neutral. Whatever the last review concluded still stands, because running
  // out of budget must never be a way to turn a red check green.
  assert.equal(github.checkRuns.length, 0);
  // The pull request is told why it went quiet. A push that silently does
  // nothing is indistinguishable from Cavix being broken.
  const said = github.comments.at(-1) ?? "";
  assert.match(said, /stopped reviewing this pull request/);
  assert.match(said, /used all 10 of its Cavix reviews/);
});
