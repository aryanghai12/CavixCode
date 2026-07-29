import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import { LocalSandboxBackend } from "@cavix/sandbox";
import { GatewayTestGenerator, Verifier } from "@cavix/verifier";
import { FakeGitHubClient, Reviewer, makeVerifyStep, runReview } from "@cavix/orchestrator";
import { makeRetentionCollector } from "../src/verify/retention.ts";
import { ALL_SECTIONS, DEFAULT_REVIEW_CONFIG } from "../src/byok/reviewConfig.ts";
import type { RecordReviewInput } from "../src/report/recorder.ts";

// Stage 13, live: the retention proof runs in the REAL teardown path rather than
// in a demo script, and what it produces is the artefact a regulated buyer's
// auditor asks for.
//
// The sandbox here is a real LocalSandboxBackend, not a fake, because the whole
// question is whether a workspace on a real filesystem is really gone.

const DIFF = `diff --git a/src/total.js b/src/total.js
--- a/src/total.js
+++ b/src/total.js
@@ -1,4 +1,5 @@ function total(items) {
   let sum = 0;
+  for (let i = 0; i <= items.length; i++) sum += items[i];
   return sum;
 }
`;

const SOURCE = `function total(items) {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) sum += items[i];
  return sum;
}
module.exports = { total };
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
    title: "Sum the items",
    author: "octocat",
    enqueued_at: "2026-07-01T00:00:00Z",
  };
}

/** A review whose one finding is worth verifying, against a real local sandbox. */
function wire() {
  const provider = new FakeProvider((req) => {
    const system = req.system ?? "";
    // Match the test generator's exact prompt marker. A loose match on "test"
    // also catches the single-model review prompt, which then returns a
    // generated test instead of findings, so nothing is ever verified and no
    // sandbox is provisioned. That is how the first version of this file
    // silently tested nothing.
    if (system.includes("You write") && system.includes("tests for")) {
      return JSON.stringify({
        testPath: "cavix.repro.test.mjs",
        testCode: "process.exit(1);\n",
      });
    }
    return JSON.stringify({
      summary: "Sums the items.",
      effort: 2,
      findings: [
        {
          path: "src/total.js",
          line: 3,
          severity: "high",
          category: "correctness",
          title: "Loop runs one past the end",
          body: "`<=` should be `<`.",
          confidence: 0.9,
        },
      ],
    });
  });
  const config: GatewayConfigData = { orgs: { acme: { provider: "fake", apiKey: "k", model: "m" } } };
  const gateway = new Gateway({ providers: new Map([["fake", provider]]), config });
  const github = new FakeGitHubClient({
    diff: DIFF,
    files: { "src/total.js": SOURCE, "package.json": '{"name":"w","scripts":{"test":"node --test"}}' },
  });
  const verify = makeVerifyStep({
    github,
    verifier: new Verifier({ sandbox: new LocalSandboxBackend(), testGen: new GatewayTestGenerator({ gateway }) }),
  });
  return { github, reviewer: new Reviewer({ gateway }), verify, gateway };
}

const config = async () => ({ ...DEFAULT_REVIEW_CONFIG, sections: ALL_SECTIONS });

test("a real review produces a retention attestation, from a real sandbox", async () => {
  const { github, reviewer, verify } = wire();
  const recorded: RecordReviewInput[] = [];

  await runReview(job(), {
    github,
    reviewer,
    verify,
    reviewConfig: config,
    recordReview: async (input) => {
      recorded.push(input);
      return true;
    },
  });

  const a = recorded[0]?.retention;
  assert.ok(a, "the review carries a retention proof");
  assert.ok(a.sandboxes >= 1, "and it covers the sandboxes the verifier really provisioned");
  assert.equal(a.verdict, "proven");
  assert.ok(a.checks.every((c) => c.status === "purged" && c.backend === "local"));
  assert.match(a.checks[0].check, /absent from the host filesystem/);
});

test("the sandbox workspace really is gone by the time the proof is written", async () => {
  // The proof has to be about the filesystem, not about our intentions. This
  // captures the workdir the verifier actually used and looks for it afterwards.
  const seen: string[] = [];
  const backend = new LocalSandboxBackend();
  const original = backend.provision.bind(backend);
  backend.provision = async (spec) => {
    const sbx = await original(spec);
    seen.push(sbx.workdir);
    return sbx;
  };

  const { github, reviewer, gateway } = wire();
  const verify = makeVerifyStep({
    github,
    verifier: new Verifier({ sandbox: backend, testGen: new GatewayTestGenerator({ gateway }) }),
  });

  const recorded: RecordReviewInput[] = [];
  await runReview(job(), {
    github,
    reviewer,
    verify,
    reviewConfig: config,
    recordReview: async (i) => {
      recorded.push(i);
      return true;
    },
  });

  assert.ok(seen.length > 0, "a sandbox was provisioned");
  for (const dir of seen) assert.equal(fs.existsSync(dir), false, `${dir} survived the review`);
  assert.equal(recorded[0]?.retention?.verdict, "proven");
});

test("no verification means no sandboxes, and the proof says exactly that", async () => {
  // Not "clean". Nothing was provisioned, so there is nothing to have leaked,
  // and claiming a verified purge would be asserting a check that never ran.
  const { github, reviewer } = wire();
  const recorded: RecordReviewInput[] = [];
  await runReview(job(), {
    github,
    reviewer,
    reviewConfig: config,
    recordReview: async (i) => {
      recorded.push(i);
      return true;
    },
  });

  const a = recorded[0]?.retention;
  assert.equal(a?.sandboxes, 0);
  assert.equal(a?.verdict, "unverified");
});

test("a purge check that blows up costs the proof, never the review", async () => {
  // The whole failure posture of this codebase, applied to the one stage whose
  // job is to reassure: a retention check that can fail a review would cost a
  // customer the thing they actually bought.
  const errors: string[] = [];
  const collector = makeRetentionCollector({
    logger: { error: (m) => errors.push(m) },
    check: async () => {
      throw new Error("docker socket is gone");
    },
  });
  await collector.onTeardown({ id: "s", backend: "docker", workdir: "/work" } as never);

  const a = collector.finish({ org: "acme" });
  assert.equal(a.sandboxes, 0, "the entry is simply missing");
  assert.equal(a.verdict, "unverified", "which reads as unverified, the truth");
  assert.equal(collector.violated(), false, "and is not confused with a violation");
  assert.match(errors[0], /could not verify a sandbox was destroyed/);
});

test("a violation is recorded and logged, and still does not fail the review", async () => {
  const collector = makeRetentionCollector({
    check: async () => ({ backend: "local", check: "c", status: "residual", residualCount: 1 }),
  });
  await collector.onTeardown({ id: "s", backend: "local", workdir: "/tmp/x" } as never);
  assert.equal(collector.violated(), true);
  assert.equal(collector.finish({ org: "acme" }).verdict, "violated");
});

test("the attestation on the wire carries nothing about the customer's code", async () => {
  // Point four of the brief, checked rather than trusted: the proof must not
  // become the retention problem. A path or a file name here would sit in a
  // database for years before anyone thought to look.
  const { github, reviewer, verify } = wire();
  const recorded: RecordReviewInput[] = [];
  await runReview(job(), {
    github,
    reviewer,
    verify,
    reviewConfig: config,
    recordReview: async (i) => {
      recorded.push(i);
      return true;
    },
  });

  const json = JSON.stringify(recorded[0].retention);
  for (const leak of ["src/total.js", "package.json", "cavix-sbx", "headsha", "acme/widget", "sum", "items"]) {
    assert.equal(json.includes(leak), false, `the attestation leaked ${leak}: ${json}`);
  }
  // Nor a review id: the orchestrator's only candidate would name the repository.
  assert.equal(recorded[0].retention?.reviewId, undefined);
});
