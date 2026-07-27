import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider } from "@cavix/gateway";
import {
  DEFAULT_REVIEW_CONFIG,
  FakeGitHubClient,
  Reviewer,
  runPreMergeChecks,
  runReview,
  shouldRequestChanges,
  type OrgReviewConfig,
} from "@cavix/orchestrator";
import { ALL_SECTIONS, coerce, makeReviewConfigFetcher } from "../src/byok/reviewConfig.ts";

// The owner's switches, enforced. Everything here is about one property: what
// the repo owner chose on the dashboard is what runs — and Cavix never blocks a
// merge that the owner did not ask it to block.

const DIFF = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,5 @@ export function handler(req, res) {
 export function handler(req, res) {
+  console.log("debugging the request", req.body);
+  return res.send("ok");
 }
`;

const SOURCE = `export function handler(req, res) {
  console.log("debugging the request", req.body);
  return res.send("ok");
}
`;

const responder = () =>
  JSON.stringify({
    summary: "Adds a handler.",
    findings: [
      { path: "src/api.ts", line: 2, severity: "low", category: "maintainability", title: "Debug logging left in", body: "", confidence: 0.9 },
    ],
  });

function job(): ReviewJob {
  return {
    schema_version: "1", idempotency_key: "k", delivery_id: "d", org: "acme",
    repo: "acme/widget", repo_id: 1, pr_number: 3, action: "opened",
    head_sha: "headsha", base_sha: "base", installation_id: 9, priority: 100,
    title: "Add handler", author: "octocat", enqueued_at: new Date().toISOString(),
  };
}

function wire() {
  const github = new FakeGitHubClient({ diff: DIFF, headSha: "headsha", files: { "src/api.ts": SOURCE } });
  const gateway = new Gateway({
    providers: new Map([["fake", new FakeProvider(responder)]]),
    config: { orgs: { acme: { provider: "fake", apiKey: "k", model: "fake-model" } } },
  });
  return { github, reviewer: new Reviewer({ gateway }) };
}

const config = (over: Partial<OrgReviewConfig> = {}): OrgReviewConfig => ({ ...DEFAULT_REVIEW_CONFIG, ...over });

// ---------- compiling the owner's sentences ----------

test("runPreMergeChecks: a rule that compiles becomes an immutable, deterministic finding", () => {
  const out = runPreMergeChecks(["Disallow calls to console.log"], [{ path: "src/api.ts", content: SOURCE }]);
  assert.equal(out.failed, 1);
  assert.equal(out.checks[0].status, "fail");
  const f = out.findings[0];
  assert.equal(f.source, "policy");
  assert.equal(f.immutable, true, "no model gets a vote on a policy finding");
  assert.equal(f.confidence, 1);
  assert.equal(f.line, 2);
  assert.match(f.body, /Org pre-merge rule/);
});

test("runPreMergeChecks: a clean file passes", () => {
  const out = runPreMergeChecks(["Disallow calls to console.log"], [{ path: "a.ts", content: "export const x = 1;\n" }]);
  assert.equal(out.passed, 1);
  assert.equal(out.failed, 0);
  assert.match(out.checks[0].detail, /Pass\. Nothing in the added lines\./);
});

// The rule that decides whether anyone keeps the gate switched on: an author who
// touches one line of a file is not answerable for what was already in it.
test("runPreMergeChecks: pre-existing violations are not attributed to this PR", () => {
  const content = 'console.log("old");\nconsole.log("also old");\nconsole.log("NEW");\n';
  const addedLines = new Map([["a.ts", new Set([3])]]); // the PR only added line 3

  const out = runPreMergeChecks(["Disallow calls to console.log"], [{ path: "a.ts", content }], addedLines);
  assert.equal(out.failed, 1);
  assert.equal(out.findings.length, 1, "only the added line is reported");
  assert.equal(out.findings[0].line, 3);
});

test("runPreMergeChecks: a file that only violates outside the change passes, and says why", () => {
  const content = 'console.log("old");\nexport const x = 1;\n';
  const addedLines = new Map([["a.ts", new Set([2])]]);

  const out = runPreMergeChecks(["Disallow calls to console.log"], [{ path: "a.ts", content }], addedLines);
  assert.equal(out.passed, 1);
  assert.equal(out.findings.length, 0);
  assert.match(out.checks[0].detail, /1 pre-existing, not attributed to this PR/);
});

// "This file is 900 lines" is true of the file being shipped no matter which
// line was touched, so whole-file rules are not line-filtered.
test("runPreMergeChecks: whole-file rules still apply even off the changed lines", () => {
  const content = Array.from({ length: 40 }, (_, i) => `const l${i} = ${i};`).join("\n");
  const addedLines = new Map([["big.ts", new Set([40])]]);

  const out = runPreMergeChecks(["Files must be under 10 lines"], [{ path: "big.ts", content }], addedLines);
  assert.equal(out.failed, 1);
  assert.equal(out.findings[0].line, 1);
});

// A green tick has to mean the check ran. A sentence that compiled to nothing is
// reported as skipped, never as a pass.
test("runPreMergeChecks: an uncompilable rule is reported as skipped, not as passing", () => {
  const out = runPreMergeChecks(["please write nice code"], [{ path: "a.ts", content: "x" }]);
  assert.equal(out.checks[0].status, "skipped");
  assert.equal(out.passed, 0);
  assert.equal(out.failed, 0);
  assert.match(out.checks[0].detail, /could not turn this sentence into a deterministic check/);
});

// ---------- blocking is the owner's call ----------

test("shouldRequestChanges: never blocks unless the owner turned blocking on", () => {
  const failing = runPreMergeChecks(["Disallow calls to console.log"], [{ path: "a.ts", content: SOURCE }]);
  assert.equal(shouldRequestChanges(config(), failing, ["critical"]), false, "blocking off → comment only");
  assert.equal(shouldRequestChanges(config({ requestChangesOnFail: true }), failing, []), true, "a failed rule blocks");
  assert.equal(
    shouldRequestChanges(config({ requestChangesOnFail: true, failOn: ["critical"] }), undefined, ["high"]),
    false,
    "high is below their critical bar",
  );
  assert.equal(
    shouldRequestChanges(config({ requestChangesOnFail: true, failOn: ["high"] }), undefined, ["critical"]),
    true,
    "critical clears a high bar",
  );
});

// ---------- the full review, gated ----------

test("the gate runs over the changed files and blocks when the owner asked for it", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), {
    github,
    reviewer,
    reviewConfig: async () => config({
      requestChangesOnFail: true,
      preMergeChecks: { enabled: true, rules: ["Disallow calls to console.log"] },
    }),
  });

  assert.equal(outcome.preMerge?.failed, 1);
  assert.equal(outcome.blocked, true);
  const review = github.lastReview()!;
  assert.equal(review.event, "REQUEST_CHANGES");
  assert.match(review.body, /Changes requested: 1 pre-merge check failed/);
  assert.match(review.body, /### Pre-merge checks\n\n\*\*1 check failing\*\*/);
  assert.match(review.body, /\| ❌ \| Disallow calls to console\.log \|/);
});

test("the same failing gate only reports when blocking is off", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), {
    github,
    reviewer,
    reviewConfig: async () => config({
      preMergeChecks: { enabled: true, rules: ["Disallow calls to console.log"] },
    }),
  });

  assert.equal(outcome.preMerge?.failed, 1);
  assert.equal(outcome.blocked, false);
  assert.equal(github.lastReview()!.event, "COMMENT");
  assert.match(github.lastReview()!.body, /Reporting only, blocking is off/);
});

// A gate that silently does not run is indistinguishable from a gate that
// passed, which defeats the entire feature.
test("a gate that cannot run says so on the PR instead of quietly passing", async () => {
  const { reviewer } = wire();
  const github = new FakeGitHubClient({ diff: DIFF, headSha: "headsha", files: {} });
  const broken = Object.assign(Object.create(Object.getPrototypeOf(github)), github, {
    fetchFile: async () => { throw new Error("github: fetch file HTTP 500"); },
  });

  const outcome = await runReview(job(), {
    github: broken,
    reviewer,
    reviewConfig: async () => config({
      requestChangesOnFail: true,
      preMergeChecks: { enabled: true, rules: ["Disallow calls to console.log"] },
    }),
  });

  assert.equal(outcome.preMerge?.skipped, 1);
  assert.equal(outcome.blocked, false, "never claim a failure that was not measured");
  const body = github.lastReview()!.body;
  assert.match(body, /### Pre-merge checks\n\n\*\*No checks ran\*\*/);
  assert.match(body, /Cavix could not run this check/);
});

// Cavix reads a bounded number of files. Scanning part of a change and calling
// it a pass is the same silent lie as never running.
test("a PR wider than the file budget marks the gate unavailable rather than partially passing", async () => {
  const { reviewer } = wire();
  const wide = Array.from({ length: 20 }, (_, i) =>
    `diff --git a/src/f${i}.ts b/src/f${i}.ts\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1,1 +1,2 @@\n const a = 1;\n+const b = ${i};\n`,
  ).join("");
  const github = new FakeGitHubClient({ diff: wide, headSha: "headsha", files: {} });

  const outcome = await runReview(job(), {
    github,
    reviewer,
    reviewConfig: async () => config({
      requestChangesOnFail: true,
      preMergeChecks: { enabled: true, rules: ["Disallow calls to console.log"] },
    }),
  });

  assert.equal(outcome.preMerge?.skipped, 1);
  assert.equal(outcome.blocked, false, "never block on a check that could not see the whole change");
  assert.match(github.lastReview()!.body, /changes 20 files, more than the 12 Cavix reads/);
});

test("runPreMergeChecks: rules with nothing to scan report unavailable, not empty", () => {
  const out = runPreMergeChecks(["Disallow calls to console.log"], []);
  assert.equal(out.skipped, 1);
  assert.equal(out.passed, 0);
  assert.match(out.checks[0].detail, /could not run/);
});

test("all rules skipped is never reported as 'all checks passing'", () => {
  const out = runPreMergeChecks(["be nice", "be tidy"], [{ path: "a.ts", content: "x" }]);
  assert.equal(out.skipped, 2);
  assert.equal(out.passed, 0);
  assert.equal(out.failed, 0);
});

test("no gate configured means no pre-merge section at all", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), { github, reviewer, reviewConfig: async () => config() });
  assert.equal(outcome.preMerge, undefined);
  assert.doesNotMatch(github.lastReview()!.body, /Pre-merge checks/);
});

// ---------- the org's switches reach the workflow ----------

test("turning verification off in the dashboard skips the sandbox entirely", async () => {
  const { github, reviewer } = wire();
  let verifyCalled = false;
  await runReview(job(), {
    github,
    reviewer,
    verify: async (findings) => {
      verifyCalled = true;
      return { surfaced: findings, suppressed: [], verifiedCount: 0, costUsd: 0 };
    },
    reviewConfig: async () => config({ verifyFindings: false }),
  });
  assert.equal(verifyCalled, false, "the org opted out of proof");
});

test("turning the description summary off keeps it in the review comment", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), {
    github,
    reviewer,
    reviewConfig: async () => config({ summaryInDescription: false }),
  });
  assert.equal(outcome.descriptionUpdated, false);
  assert.equal(github.pullBody, "", "the author's description is left alone");
  assert.match(github.lastReview()!.body, /### Summary/);
});

// ---------- the review-structure toggles actually change the review ----------

test("turning inline findings off moves every explanation into the comment", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), {
    github,
    reviewer,
    reviewConfig: async () => config({ sections: { ...ALL_SECTIONS, inlineFindings: false } }),
  });

  assert.equal(outcome.inlineCount, 0, "no inline comments are posted");
  assert.equal(github.lastReview()!.comments.length, 0);
  const body = github.lastReview()!.body;
  assert.match(body, /Debug logging left in/, "the finding is still listed");
  assert.match(body, /Full detail for 1 finding/, "and its explanation is here instead");
  assert.match(body, /inline comments are off for this workspace/);
});

test("turning the walkthrough and effort off strips them from the description", async () => {
  const { github, reviewer } = wire();
  await runReview(job(), {
    github,
    reviewer,
    reviewConfig: async () => config({ sections: { ...ALL_SECTIONS, changedFiles: false, reviewEffort: false } }),
  });

  assert.match(github.pullBody, /### Summary/, "the summary itself stays");
  assert.doesNotMatch(github.pullBody, /### Changes/);
  assert.doesNotMatch(github.pullBody, /review effort/);
});

// Switching both off leaves nothing worth saying, so don't edit the author's
// description at all.
test("with summary and walkthrough both off the PR description is left untouched", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), {
    github,
    reviewer,
    reviewConfig: async () => config({ sections: { ...ALL_SECTIONS, summary: false, changedFiles: false } }),
  });

  assert.equal(outcome.descriptionUpdated, false);
  assert.equal(github.pullBody, "");
  assert.doesNotMatch(github.lastReview()!.body, /### Summary/);
  assert.match(github.lastReview()!.body, /### Findings/, "findings are still posted");
});

test("turning proof off drops the sandbox transcript but keeps the verified badge", async () => {
  const { github, reviewer } = wire();
  const proven = {
    status: "VERIFIED" as const,
    exploit: false,
    reproduced: true,
    fixWorks: true,
    reason: "reproduced",
    steps: [{ step: "repro", cmd: "node --test x.mjs", code: 1 }],
  };
  await runReview(job(), {
    github,
    reviewer,
    verify: async (findings) => ({
      surfaced: findings.map((f) => ({ ...f, verification: proven })),
      suppressed: [],
      verifiedCount: findings.length,
      costUsd: 0,
    }),
    reviewConfig: async () => config({ sections: { ...ALL_SECTIONS, proof: false } }),
  });

  const inline = github.lastReview()!.comments[0].body;
  assert.match(inline, /✅ verified/, "the finding is still marked as proven");
  assert.doesNotMatch(inline, /\*\*Proof\*\*/, "but the transcript is not shown");
});

test("coerce: review sections default to on and survive a partial payload", () => {
  assert.deepEqual(coerce({}).sections, ALL_SECTIONS);
  assert.equal(coerce({ reviewSections: { proof: false } }).sections.proof, false);
  assert.equal(coerce({ reviewSections: { proof: false } }).sections.summary, true);
});

// ---------- fetching the config ----------

// An unreachable dashboard must not silently downgrade a customer's review, and
// must not silently start blocking their merges either.
test("config defaults are safe: proof on, blocking off", () => {
  assert.equal(DEFAULT_REVIEW_CONFIG.verifyFindings, true);
  assert.equal(DEFAULT_REVIEW_CONFIG.summaryInDescription, true);
  assert.equal(DEFAULT_REVIEW_CONFIG.requestChangesOnFail, false);
});

test("coerce: missing fields take the safe default, never undefined-as-false", () => {
  assert.deepEqual(coerce({}), DEFAULT_REVIEW_CONFIG);
  assert.equal(coerce({ verifyFindings: false }).verifyFindings, false);
  assert.equal(coerce({ requestChangesOnFail: "yes" }).requestChangesOnFail, false, "only a real true counts");
  assert.deepEqual(coerce({ preMergeChecks: { enabled: true, rules: ["a", "", "  "] } }).preMergeChecks.rules, ["a"]);
});

// A control-plane that accepts the connection and then never answers would
// otherwise stall every review queued behind it.
test("a hung control-plane times out instead of stalling the review", async () => {
  const fetcher = makeReviewConfigFetcher({
    url: "http://cp",
    token: "t",
    timeoutMs: 40,
    fetchImpl: ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch,
  });
  const started = Date.now();
  assert.deepEqual(await fetcher("acme"), DEFAULT_REVIEW_CONFIG);
  assert.ok(Date.now() - started < 2000, "gave up quickly rather than hanging");
});

test("an unreachable control-plane falls back to the safe defaults", async () => {
  const fetcher = makeReviewConfigFetcher({
    url: "http://127.0.0.1:1",
    token: "t",
    fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
  });
  assert.deepEqual(await fetcher("acme"), DEFAULT_REVIEW_CONFIG);
});

test("the config is fetched once and cached across reviews", async () => {
  let calls = 0;
  const fetcher = makeReviewConfigFetcher({
    url: "http://cp",
    token: "t",
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ verifyFindings: false }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await fetcher("acme");
  await fetcher("acme");
  assert.equal(calls, 1);
  assert.equal((await fetcher("acme")).verifyFindings, false);
});
