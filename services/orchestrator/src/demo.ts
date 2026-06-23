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
import { Reviewer } from "./reviewer/reviewer.ts";
import { FakeGitHubClient } from "./github/fake.ts";
import { runReview, type WorkflowLogger } from "./workflow/reviewWorkflow.ts";

const DIFF = `diff --git a/src/auth.js b/src/auth.js
--- a/src/auth.js
+++ b/src/auth.js
@@ -8,6 +8,11 @@ const db = require("./db");
 function login(req, res) {
   const user = req.body.username;
   const pass = req.body.password;
+  // Look up the user
+  const row = db.query(
+    "SELECT * FROM users WHERE name = '" + user + "' AND pass = '" + pass + "'"
+  );
+  if (row) { res.cookie("session", user); return res.send("ok"); }
   return res.status(401).send("denied");
 }
`;

// Deterministic stand-in for Claude: returns findings as the real model would.
const responder = () =>
  JSON.stringify({
    summary:
      "Adds a login path that builds a SQL query by concatenating untrusted request input, and sets a session cookie with no signing.",
    findings: [
      {
        path: "src/auth.js",
        line: 12,
        severity: "critical",
        category: "security",
        title: "SQL injection from concatenated request input",
        body:
          "`user` and `pass` come straight from `req.body` and are concatenated into the SQL string, allowing authentication bypass and data exfiltration (e.g. `' OR '1'='1`). Use a parameterized query.",
        suggestion:
          'const row = db.query("SELECT * FROM users WHERE name = ? AND pass = ?", [user, pass]);',
        confidence: 0.97,
      },
      {
        path: "src/auth.js",
        line: 13,
        severity: "high",
        category: "security",
        title: "Unsigned session cookie",
        body:
          "The session cookie stores the raw username with no signing/HMAC, so a client can forge a session for any user. Use a signed, httpOnly cookie or a server-side session id.",
        confidence: 0.8,
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
  const github = new FakeGitHubClient({ diff: DIFF });
  const reviewer = new Reviewer({ gateway });

  console.log("── workflow logs ──────────────────────────────────────────────");
  const started = Date.now();
  const outcome = await runReview(job, { github, reviewer, logger: jsonLogger });
  const elapsed = Date.now() - started;

  const review = github.lastReview()!;
  console.log("\n── posted PR review (acme/widget#42) ─────────────────────────");
  console.log(`POST /repos/acme/widget/pulls/42/reviews  → ${outcome.posted.htmlUrl}`);
  console.log(`event: ${review.event}   inline comments: ${review.comments.length}   latency: ${elapsed}ms`);
  console.log("\n[summary body]\n" + review.body);
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
