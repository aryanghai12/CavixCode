// Runnable demonstration of the Stage 0 → Stage 1 path with NO external infra.
// It wires the real workflow (reviewer → poster → GitHub posting) against the
// in-process fakes, then prints (a) the structured workflow logs and (b) the
// exact review payload that would be sent to GitHub — i.e. "the posted PR
// comment". Swap FakeProvider→AnthropicProvider and FakeGitHubClient→
// RestGitHubClient (see main.ts) to run it for real with BYOK keys.
//
//   node services/orchestrator/src/demo.ts

import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import { LocalSandboxBackend } from "@cavix/sandbox";
import { FakeTestGenerator, Verifier } from "@cavix/verifier";
import { Reviewer } from "./reviewer/reviewer.ts";
import { FakeGitHubClient } from "./github/fake.ts";
import { makeVerifyStep } from "./verify/verify.ts";
import { makeDeepReviewStep } from "./pipeline/deepReview.ts";
import { runReview, type WorkflowLogger } from "./workflow/reviewWorkflow.ts";

const DIFF = `diff --git a/src/auth.mjs b/src/auth.mjs
--- a/src/auth.mjs
+++ b/src/auth.mjs
@@ -1,4 +1,7 @@ export function buildLoginQuery(user, pass) {
 export function buildLoginQuery(user, pass) {
-  return { sql: "SELECT * FROM users WHERE name = ? AND pass = ?", params: [user, pass] };
+  // Look up the user
+  return {
+    sql: "SELECT * FROM users WHERE name = '" + user + "' AND pass = '" + pass + "'",
+  };
 }
`;

// The file as it exists at the head commit — what Cavix fetches to RUN the code.
const HEAD_SOURCE = `export function buildLoginQuery(user, pass) {
  // Look up the user
  return {
    sql: "SELECT * FROM users WHERE name = '" + user + "' AND pass = '" + pass + "'",
  };
}
`;

const FIXED_SOURCE = `export function buildLoginQuery(user, pass) {
  return { sql: "SELECT * FROM users WHERE name = ? AND pass = ?", params: [user, pass] };
}
`;

// The PoC the test generator would write: it PASSES while the injection works,
// which is what makes it proof rather than opinion.
const EXPLOIT_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLoginQuery } from "./src/auth.mjs";

test("PoC: a crafted username rewrites the WHERE clause", () => {
  const { sql } = buildLoginQuery("admin' OR '1'='1", "anything");
  assert.match(sql, /OR '1'='1/);
});
`;

// Deterministic stand-in for Claude: returns findings as the real model would.
const responder = () =>
  JSON.stringify({
    summary:
      "Replaces the parameterised login query with one built by string concatenation, so untrusted input reaches the SQL text.",
    walkthrough: [
      { path: "src/auth.mjs", summary: "Build the login query by concatenation instead of parameters" },
    ],
    effort: 3,
    findings: [
      {
        path: "src/auth.mjs",
        line: 4,
        severity: "critical",
        category: "security",
        title: "SQL injection from concatenated request input",
        body:
          "`user` and `pass` are concatenated into the SQL string, allowing authentication bypass and data exfiltration (e.g. `' OR '1'='1`). Use a parameterized query.",
        suggestion:
          '    sql: "SELECT * FROM users WHERE name = ? AND pass = ?",',
        confidence: 0.97,
      },
      {
        path: "src/auth.mjs",
        line: 2,
        severity: "medium",
        category: "maintainability",
        title: "Comment restates the code",
        body: "`// Look up the user` adds nothing over the function name.",
        confidence: 0.35,
      },
    ],
  });

const job: ReviewJob = {
  schema_version: "1",
  idempotency_key: "demo-idem",
  delivery_id: "demo-delivery",
  org: "acme",
  repo: "acme/widget",
  repo_id: 1,
  pr_number: 42,
  action: "opened",
  head_sha: "a1b2c3d4",
  base_sha: "00000000",
  installation_id: 99,
  priority: 100,
  title: "Add login lookup",
  author: "octocat",
  enqueued_at: new Date().toISOString(),
};

const jsonLogger: WorkflowLogger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: "info", service: "orchestrator", msg, ...meta })),
  error: (msg, meta) => console.log(JSON.stringify({ level: "error", service: "orchestrator", msg, ...meta })),
};

async function main() {
  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "byok-acme-DEMO", model: "claude-sonnet-4-6" } },
  };
  const gateway = new Gateway({
    providers: new Map([["fake", new FakeProvider(responder)]]),
    config,
    logger: {
      info: (msg, meta) => console.log(JSON.stringify({ level: "info", service: "gateway", msg, ...meta })),
      warn: (msg, meta) => console.log(JSON.stringify({ level: "warn", service: "gateway", msg, ...meta })),
    },
  });
  const github = new FakeGitHubClient({
    diff: DIFF,
    headSha: "a1b2c3d4",
    body: "Speeds up the login lookup.\n\nCloses #17.",
    files: { "src/auth.mjs": HEAD_SOURCE },
  });
  const reviewer = new Reviewer({ gateway });

  // Stage 10 for real: a LOCAL sandbox running actual `node --test` processes.
  // Only the test-generation model is faked — everything it produces is executed.
  const verify = makeVerifyStep({
    github,
    verifier: new Verifier({
      sandbox: new LocalSandboxBackend(),
      testGen: new FakeTestGenerator(() => ({
        testPath: "auth.exploit.test.mjs",
        testCode: EXPLOIT_TEST,
        fix: { path: "src/auth.mjs", content: FIXED_SOURCE },
        semantics: "exploit-passes-on-vuln",
      })),
    }),
    logger: jsonLogger,
  });

  // Stages 3, 4, 7, 8 and 9 over the same fake provider: the deterministic
  // scanners and the call graph are REAL here, only the models are faked.
  const deepReview = makeDeepReviewStep({ gateway, github, logger: jsonLogger });

  console.log("── workflow logs ──────────────────────────────────────────────");
  const started = Date.now();
  const outcome = await runReview(job, { github, reviewer, deepReview, verify, logger: jsonLogger });
  const elapsed = Date.now() - started;

  const review = github.lastReview()!;

  console.log("\n── checks box (acme/widget#42) ───────────────────────────────");
  for (const c of github.checkRuns) {
    console.log(`Cavix Review  ${c.status}${c.conclusion ? ` / ${c.conclusion}` : ""}  ${c.title}`);
  }
  const finalCheck = github.lastCheckRun();
  if (finalCheck) console.log(`\n${finalCheck.summary}`);

  console.log("\n── PR description (acme/widget#42) ───────────────────────────");
  console.log(`PATCH /repos/acme/widget/pulls/42  → summary written: ${outcome.descriptionUpdated}`);
  console.log("\n" + github.pullBody);

  console.log("\n── posted PR review (acme/widget#42) ─────────────────────────");
  console.log(`POST /repos/acme/widget/pulls/42/reviews  → ${outcome.posted.htmlUrl}`);
  console.log(
    `event: ${review.event}   inline: ${review.comments.length}   verified: ${outcome.verifiedCount}   suppressed: ${outcome.suppressedCount}   latency: ${elapsed}ms`,
  );
  console.log("\n[review comment]\n" + review.body);
  for (const c of review.comments) {
    console.log(`\n[inline] ${c.path}:${c.line}\n` + c.body);
  }
  console.log("\n── cost accounting (Stage 13) ────────────────────────────────");
  for (const r of gateway.costLog()) {
    console.log(
      JSON.stringify({ org: r.org, model: r.model, key_fp: r.keyFingerprint, in: r.inputTokens, out: r.outputTokens, cost_usd: r.costUsd }),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
