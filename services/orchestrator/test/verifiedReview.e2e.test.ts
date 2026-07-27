import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider } from "@cavix/gateway";
import { LocalSandboxBackend } from "@cavix/sandbox";
import { FakeTestGenerator, Verifier } from "@cavix/verifier";
import {
  FakeGitHubClient,
  Reviewer,
  makeReviewHandler,
  makeVerifyStep,
  runReview,
  SUMMARY_START,
} from "@cavix/orchestrator";

// The whole product claim, end to end and offline: a model reports a bug, Cavix
// fetches the real file, reproduces the bug by RUNNING it in a sandbox, applies
// the fix, re-runs, and only then posts — with the transcript attached. A second
// finding that cannot be reproduced is dropped instead of shown.
//
// The sandbox here is the real LocalSandboxBackend executing real `node --test`
// processes. Only the test-generation model is faked, because that is the part
// that would otherwise need a live API key.

const BUGGY = `export function lastN(arr, n) {
  const out = [];
  for (let i = arr.length - n; i <= arr.length; i++) out.push(arr[i]);
  return out;
}
`;
const FIXED = BUGGY.replace("i <= arr.length", "i < arr.length");

const REPRO_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { lastN } from "./calc.mjs";
test("lastN returns the last n elements", () => {
  assert.deepEqual(lastN([1,2,3,4], 2), [3,4]);
});
`;

const DIFF = `diff --git a/calc.mjs b/calc.mjs
--- a/calc.mjs
+++ b/calc.mjs
@@ -1,4 +1,4 @@ export function lastN(arr, n) {
 export function lastN(arr, n) {
   const out = [];
-  for (let i = arr.length - n; i < arr.length; i++) out.push(arr[i]);
+  for (let i = arr.length - n; i <= arr.length; i++) out.push(arr[i]);
   return out;
 }
`;

/** The model's reply: one real bug, one imagined one. */
const responder = () =>
  JSON.stringify({
    summary: "Rewrites the lastN loop bound.",
    walkthrough: [{ path: "calc.mjs", summary: "Change the loop bound in lastN" }],
    effort: 2,
    findings: [
      {
        path: "calc.mjs",
        line: 3,
        severity: "high",
        category: "correctness",
        title: "Off-by-one reads past the end of the array",
        body: "`i <= arr.length` runs one iteration too many, pushing undefined.",
        suggestion: "  for (let i = arr.length - n; i < arr.length; i++) out.push(arr[i]);",
        confidence: 0.9,
      },
      {
        path: "calc.mjs",
        line: 3,
        severity: "high",
        category: "correctness",
        title: "Imagined second bug that does not exist",
        body: "This one cannot be reproduced.",
        confidence: 0.6,
      },
    ],
  });

function job(): ReviewJob {
  return {
    schema_version: "1",
    idempotency_key: "verify-e2e",
    delivery_id: "d1",
    org: "acme",
    repo: "acme/widget",
    repo_id: 1,
    pr_number: 7,
    action: "opened",
    head_sha: "headsha",
    base_sha: "basesha",
    installation_id: 42,
    priority: 100,
    title: "Tweak lastN",
    author: "octocat",
    enqueued_at: new Date().toISOString(),
  };
}

function wire() {
  const github = new FakeGitHubClient({
    diff: DIFF,
    headSha: "headsha",
    body: "Fixes #1.",
    files: { "calc.mjs": BUGGY },
  });
  const gateway = new Gateway({
    providers: new Map([["fake", new FakeProvider(responder)]]),
    config: { orgs: { acme: { provider: "fake", apiKey: "k", model: "fake-model" } } },
  });

  // The generator returns a working repro + fix for the real finding, and a test
  // that passes (i.e. proves nothing) for the imagined one.
  let call = 0;
  const verifier = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => {
      call++;
      return call === 1
        ? { testPath: "calc.repro.test.mjs", testCode: REPRO_TEST, fix: { path: "calc.mjs", content: FIXED }, semantics: "test-fails-on-bug" }
        : { testPath: "nothing.repro.test.mjs", testCode: 'import { test } from "node:test";\ntest("nothing", () => {});\n', semantics: "test-fails-on-bug" };
    }),
  });

  return {
    github,
    reviewer: new Reviewer({ gateway }),
    verify: makeVerifyStep({ github, verifier }),
  };
}

test("a real bug is reproduced in the sandbox and posted with its proof", async () => {
  const { github, reviewer, verify } = wire();
  const outcome = await runReview(job(), { github, reviewer, verify });

  assert.equal(outcome.verifiedCount, 1, "the real bug was proven by running it");
  assert.equal(outcome.suppressedCount, 1, "the imagined bug did not reproduce and was dropped");
  assert.equal(outcome.findingCount, 1, "only the proven finding was posted");

  const review = github.lastReview()!;
  const inline = review.comments[0].body;
  assert.match(inline, /✅ verified/);
  assert.match(inline, /\*\*Proof\*\* — reproduced in a sealed sandbox/);
  // The transcript is real: the repro FAILED before the fix and PASSED after it.
  assert.match(inline, /\[repro\].*→ exit 1 +bug reproduced/);
  assert.match(inline, /\[after-fix\].*→ exit 0 +suggested fix resolves it/);
  assert.doesNotMatch(review.body, /Imagined second bug/, "a disproven finding is never shown");
  assert.match(review.body, /🔕 1 finding suppressed/);
});

test("the summary lands in the PR description, keeping what the author wrote", async () => {
  const { github, reviewer, verify } = wire();
  const outcome = await runReview(job(), { github, reviewer, verify });

  assert.equal(outcome.descriptionUpdated, true);
  assert.match(github.pullBody, /^Fixes #1\./, "the author's description is preserved");
  assert.ok(github.pullBody.includes(SUMMARY_START));
  assert.match(github.pullBody, /### Summary\n\nRewrites the lastN loop bound\./);
  assert.match(github.pullBody, /\| \[`calc\.mjs`\]\S+ \| Change the loop bound in lastN \|/);
  // …and not in the review comment, which is for findings.
  assert.doesNotMatch(github.lastReview()!.body, /### Summary/);
});

test("a re-review updates the same description block rather than appending another", async () => {
  const { github, reviewer, verify } = wire();
  await runReview(job(), { github, reviewer, verify });
  await runReview(job(), { github, reviewer, verify });

  assert.equal(github.pullBody.split(SUMMARY_START).length - 1, 1);
  assert.equal(github.pullBody.indexOf("Fixes #1."), 0);
});

test("a sandbox failure costs the receipts, never the review", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), {
    github,
    reviewer,
    verify: async () => {
      throw new Error("docker daemon unreachable");
    },
  });

  assert.equal(outcome.findingCount, 2, "both findings post, unproven");
  assert.equal(outcome.verifiedCount, 0);
  assert.equal(github.submissions.length, 1, "the review still went out");
});

test("verification is skipped entirely when no finding is worth proving", async () => {
  const { github } = wire();
  let called = false;
  const nits = () =>
    JSON.stringify({
      summary: "Comment tweaks.",
      findings: [
        { path: "calc.mjs", line: 3, severity: "low", category: "maintainability", title: "nit", body: "", confidence: 0.3 },
      ],
    });
  const gateway = new Gateway({
    providers: new Map([["fake", new FakeProvider(nits)]]),
    config: { orgs: { acme: { provider: "fake", apiKey: "k", model: "fake-model" } } },
  });
  const verifier = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => {
      called = true;
      return { testPath: "x.mjs", testCode: "x", semantics: "test-fails-on-bug" };
    }),
  });

  await runReview(job(), {
    github,
    reviewer: new Reviewer({ gateway }),
    verify: makeVerifyStep({ github, verifier }),
  });
  assert.equal(called, false, "a low-confidence nit does not pay for a sandbox run");
});

test("the acknowledgment trail still ends in 🚀 with verification on", async () => {
  const { github, reviewer, verify } = wire();
  const commandJob = { ...job(), trigger: "command", command: "review", comment_id: 99, head_sha: "" };
  await makeReviewHandler({ github, reviewer, verify, gate: async () => ({ enabled: true, org: "acme" }) })(commandJob);

  assert.deepEqual(github.reactions.map((r) => r.content), ["eyes", "rocket"]);
  assert.equal(github.submissions.length, 1);
});
