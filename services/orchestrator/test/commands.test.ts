import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import {
  ALL_SECTIONS,
  FakeGitHubClient,
  makeReviewHandler,
  PAUSED_MARKER,
  Reviewer,
  runReview,
  type OrgReviewConfig,
} from "@cavix/orchestrator";

// What "@cavixcode <something>" does, and what the dashboard's switches do.
//
// Everything here was broken in the same way: the setting or the command existed
// at one end of the system and nothing read it at the other. The edge parsed
// eight commands and the orchestrator ran a full review for every one, so
// "@cavixcode help" made a frontier-model call and posted a review. Four
// dashboard settings were stored, displayed, and never consulted.
//
// So these tests mostly assert a NEGATIVE: that the model was not called, that
// no review was posted, that the excluded file never reached the provider. That
// is the shape of the bug, so it has to be the shape of the test.

const DIFF = `diff --git a/src/auth.js b/src/auth.js
--- a/src/auth.js
+++ b/src/auth.js
@@ -10,3 +10,5 @@ function login(user) {
   const token = sign(user);
   cache.set(user.id, token);
+  db.query("SELECT * FROM u WHERE id = " + user.id);
+  return token;
 }
diff --git a/vendor/lib.min.js b/vendor/lib.min.js
--- a/vendor/lib.min.js
+++ b/vendor/lib.min.js
@@ -1,1 +1,2 @@ (function(){
 (function(){
+var a=1;
`;

const FINDING = {
  path: "src/auth.js",
  line: 12,
  severity: "high",
  category: "security",
  title: "SQL injection via string concatenation",
  body: "user.id is concatenated into SQL.",
  confidence: 0.93,
};

/** A gateway that records every prompt it was asked to complete. */
function wire(opts: { findings?: unknown[]; answer?: string; github?: Record<string, unknown> } = {}) {
  const calls: Array<{ system: string; user: string }> = [];
  const provider = new FakeProvider((req) => {
    calls.push({
      system: req.system ?? "",
      user: req.messages.map((m) => m.content).join("\n"),
    });
    // The ask path wants prose; the review path wants the finding schema.
    if ((req.system ?? "").includes("answering one question")) {
      return opts.answer ?? "Yes, the retry path is guarded.";
    }
    return JSON.stringify({
      summary: "Adds a DB lookup on login.",
      effort: 2,
      findings: opts.findings ?? [FINDING],
    });
  });
  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "byok-acme", model: "claude-sonnet-4-6" } },
  };
  const gateway = new Gateway({ providers: new Map([["fake", provider]]), config });
  const github = new FakeGitHubClient({ diff: DIFF, ...(opts.github ?? {}) });
  const reviewer = new Reviewer({ gateway });
  return { github, reviewer, calls };
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

function autoJob(): ReviewJob {
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

function commandJob(command: string, args = ""): ReviewJob {
  return {
    ...autoJob(),
    action: "command",
    trigger: "command",
    command,
    command_args: args,
    comment_id: 77,
    author_association: "OWNER",
    force_fresh: command === "review",
  };
}

const handler = (deps: Parameters<typeof makeReviewHandler>[0]) =>
  makeReviewHandler({ gate: async () => ({ enabled: true, org: "acme" }), ...deps });

// ── the seven commands that must never reach a model ─────────────────────────

test("help posts the command table and calls no model at all", async () => {
  const { github, reviewer, calls } = wire();
  await handler({ github, reviewer })(commandJob("help"));

  assert.equal(calls.length, 0, "a help request must not be billable");
  assert.equal(github.submissions.length, 0, "and must not post a review");
  assert.match(github.comments[0], /@cavixcode review/);
  assert.match(github.comments[0], /@cavixcode pause/);
  assert.deepEqual(github.reactions.map((r) => r.content), ["eyes", "rocket"]);
});

test("a bare mention is help, not a review", async () => {
  // The edge sends command="help" for "@cavixcode" with nothing after it.
  const { github, reviewer, calls } = wire();
  await handler({ github, reviewer })(commandJob("help"));
  assert.equal(calls.length, 0);
  assert.equal(github.submissions.length, 0);
});

test("configure points at the dashboard instead of reviewing", async () => {
  const { github, reviewer, calls } = wire();
  await handler({ github, reviewer })(commandJob("configure"));
  assert.equal(calls.length, 0);
  assert.equal(github.submissions.length, 0);
  assert.match(github.comments[0], /Review settings/);
});

test("pause stops automatic reviews on this pull request", async () => {
  const { github, reviewer, calls } = wire();
  const deps = { github, reviewer };

  await handler(deps)(commandJob("pause"));
  assert.equal(calls.length, 0, "pausing is not a review");
  assert.equal(github.submissions.length, 0);
  assert.ok(github.comments[0].includes(PAUSED_MARKER), "the pause is recorded on the PR itself");

  // The next automatic push is now skipped, silently and for free.
  await handler(deps)(autoJob());
  assert.equal(calls.length, 0, "a paused PR must not call the model");
  assert.equal(github.submissions.length, 0);
});

test("an explicit review overrides a pause, and clears it", async () => {
  const { github, reviewer, calls } = wire();
  const deps = { github, reviewer };
  await handler(deps)(commandJob("pause"));

  await handler(deps)(commandJob("review"));
  assert.equal(github.submissions.length, 1, "asking for a review by name always wins");
  assert.equal(calls.length, 1);

  // And the pause is gone, so pushes resume on their own.
  await handler(deps)(autoJob());
  assert.equal(github.submissions.length, 2);
});

test("resume lifts the pause", async () => {
  const { github, reviewer } = wire();
  const deps = { github, reviewer };
  await handler(deps)(commandJob("pause"));
  await handler(deps)(commandJob("resume"));

  await handler(deps)(autoJob());
  assert.equal(github.submissions.length, 1, "automatic reviews are back on");
});

test("resolve dismisses the blocking review and deletes the inline comments", async () => {
  const { github, reviewer, calls } = wire();
  // A blocking review first, so there is something real to resolve.
  await runReview(autoJob(), {
    github,
    reviewer,
    reviewConfig: async () => config({ requestChangesOnFail: true, failOn: ["high"] }),
  });
  assert.equal(github.submissions[0].review.event, "REQUEST_CHANGES");
  const modelCallsBefore = calls.length;

  await handler({ github, reviewer })(commandJob("resolve"));

  assert.equal(calls.length, modelCallsBefore, "resolving is a repository operation, not a review");
  assert.equal(github.submissions.length, 1, "no second review is posted");
  assert.equal(github.dismissed.length, 1, "the review that was blocking the merge is dismissed");
  assert.ok(github.deletedComments.length > 0, "and its inline comments are removed");
  assert.match(github.comments.at(-1)!, /Resolved\./);
});

test("resolve on a clean pull request says there was nothing to do", async () => {
  const { github, reviewer } = wire();
  await handler({ github, reviewer })(commandJob("resolve"));
  assert.match(github.comments[0], /Nothing to resolve/);
});

// ── the two commands that do reach a model, each in its own way ──────────────

test("a question is answered in prose, with no review and no findings", async () => {
  const { github, reviewer, calls } = wire({ answer: "No. The retry path calls refund() again." });
  await handler({
    github,
    reviewer,
    answer: async (job, ref, org, question) =>
      (await reviewer.ask({ org, title: job.title, diff: await github.fetchPullDiff(ref), question })).answer,
  })(commandJob("ask", "is the refund idempotent?"));

  assert.equal(github.submissions.length, 0, "a question must not post a review");
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /answering one question/, "the ask prompt, not the review prompt");
  assert.match(calls[0].user, /is the refund idempotent\?/);
  // The reply quotes the question back, so the thread reads as a conversation.
  assert.match(github.comments[0], /> is the refund idempotent\?/);
  assert.match(github.comments[0], /No\. The retry path calls refund\(\) again\./);
});

test("a question with no answerer configured says so rather than reviewing", async () => {
  const { github, reviewer, calls } = wire();
  await handler({ github, reviewer })(commandJob("ask", "why?"));
  assert.equal(github.submissions.length, 0);
  assert.equal(calls.length, 0);
  assert.match(github.comments[0], /not enabled on this deployment/);
});

test("summary rewrites the description and posts no review", async () => {
  const { github, reviewer, calls } = wire();
  await handler({ github, reviewer })(commandJob("summary"));

  assert.equal(calls.length, 1, "a summary needs the model to read the diff");
  assert.equal(github.submissions.length, 0, "but nothing is posted as a review");
  assert.match(github.pullBody, /## ◈ Cavix Summary/);
  assert.match(github.pullBody, /Adds a DB lookup on login\./);
  assert.equal(github.lastCheckRun()!.title, "Summary refreshed");
});

// ── freshness: a re-review replaces the last one ─────────────────────────────

test("an explicit review clears what the previous one left behind", async () => {
  const { github, reviewer } = wire();
  const deps = { github, reviewer };

  await handler(deps)(autoJob()); // first review, posts an inline comment
  assert.equal(github.submissions.length, 1);
  assert.equal(github.deletedComments.length, 0);

  await handler(deps)(commandJob("review"));
  assert.equal(github.submissions.length, 2, "the fresh review is posted");
  assert.ok(github.deletedComments.length > 0, "the earlier inline comments are gone");
});

test("an ordinary push does NOT wipe the previous review", async () => {
  // Only an explicit "@cavixcode review" is a fresh start. Deleting the last
  // review's comments on every push would erase a thread someone was replying to.
  const { github, reviewer } = wire();
  const deps = { github, reviewer };
  await handler(deps)(autoJob());
  await handler(deps)(autoJob());
  assert.equal(github.submissions.length, 2);
  assert.equal(github.deletedComments.length, 0);
});

// ── the four dashboard settings that used to do nothing ──────────────────────

test("path filters keep an excluded file out of the model's input entirely", async () => {
  const { github, reviewer, calls } = wire();
  await runReview(autoJob(), {
    github,
    reviewer,
    reviewConfig: async () => config({ pathFilters: { include: [], exclude: ["vendor/**"] } }),
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].user, /src\/auth\.js/, "the reviewable file is still sent");
  assert.doesNotMatch(
    calls[0].user,
    /vendor\/lib\.min\.js/,
    "the excluded file never reaches the provider, so it is never billed or disclosed",
  );
});

test("an include list reviews only what it names", async () => {
  const { github, reviewer, calls } = wire();
  await runReview(autoJob(), {
    github,
    reviewer,
    reviewConfig: async () => config({ pathFilters: { include: ["vendor/**"], exclude: [] } }),
  });
  assert.match(calls[0].user, /vendor\/lib\.min\.js/);
  assert.doesNotMatch(calls[0].user, /src\/auth\.js/);
});

test("filtering everything out posts no review, and says why on the check", async () => {
  const { github, reviewer, calls } = wire();
  const outcome = await runReview(autoJob(), {
    github,
    reviewer,
    reviewConfig: async () => config({ pathFilters: { include: [], exclude: ["**"] } }),
  });

  assert.equal(calls.length, 0, "nothing to review means nothing to pay for");
  assert.equal(github.submissions.length, 0);
  assert.equal(outcome.findingCount, 0);
  assert.equal(github.lastCheckRun()!.title, "Nothing to review");
  assert.match(github.lastCheckRun()!.summary, /excluded by your path filters/);
});

test("the chosen tone reaches the model's system prompt", async () => {
  const { github, reviewer, calls } = wire();
  await runReview(autoJob(), { github, reviewer, reviewConfig: async () => config({ tone: "educational" }) });
  assert.match(calls[0].system, /Voice: teaching/);

  const second = wire();
  await runReview(autoJob(), {
    github: second.github,
    reviewer: second.reviewer,
    reviewConfig: async () => config({ tone: "assertive" }),
  });
  assert.match(second.calls[0].system, /Voice: direct/);
  assert.doesNotMatch(second.calls[0].system, /Voice: teaching/);
});

test("auto-review off stops pushes but not an explicit review", async () => {
  const { github, reviewer, calls } = wire();
  const deps = { github, reviewer, reviewConfig: async () => config({ autoReview: false }) };

  await handler(deps)(autoJob());
  assert.equal(calls.length, 0, "no automatic review, and no bill for one");
  assert.equal(github.submissions.length, 0);

  await handler(deps)(commandJob("review"));
  assert.equal(github.submissions.length, 1, "a human asking by name still gets a review");
});

test("a draft is skipped unless the workspace opted into reviewing drafts", async () => {
  const off = wire({ github: { draft: true } });
  await handler({
    github: off.github,
    reviewer: off.reviewer,
    reviewConfig: async () => config({ reviewDraftPRs: false }),
  })(autoJob());
  assert.equal(off.github.submissions.length, 0);
  assert.equal(off.calls.length, 0);

  const on = wire({ github: { draft: true } });
  await handler({
    github: on.github,
    reviewer: on.reviewer,
    reviewConfig: async () => config({ reviewDraftPRs: true }),
  })(autoJob());
  assert.equal(on.github.submissions.length, 1);
});

test("a workspace refused by the gate is told the real reason", async () => {
  // Two different situations, two different messages. Telling someone whose
  // workspace is over quota to "turn the repo on" sends them to a settings page
  // where the toggle is already green.
  const { github, reviewer, calls } = wire();
  await makeReviewHandler({
    github,
    reviewer,
    gate: async () => ({ enabled: false, org: "acme", reason: "This workspace is suspended. Contact support." }),
  })(commandJob("review"));

  assert.equal(calls.length, 0, "refused before anything is spent");
  assert.equal(github.submissions.length, 0);
  assert.match(github.comments[0], /This workspace is suspended\./);
  assert.doesNotMatch(github.comments[0], /Turn it on/, "the repo is on; that is not the problem");
});

test("a repo that was never connected still gets the connect instructions", async () => {
  const { github, reviewer } = wire();
  await makeReviewHandler({ github, reviewer, gate: async () => ({ enabled: false }) })(commandJob("review"));
  assert.match(github.comments[0], /Turn it on in the Cavix dashboard/);
});

test("a draft still gets reviewed when someone asks for it by name", async () => {
  const { github, reviewer } = wire({ github: { draft: true } });
  await handler({ github, reviewer, reviewConfig: async () => config({ reviewDraftPRs: false }) })(
    commandJob("review"),
  );
  assert.equal(github.submissions.length, 1);
});
