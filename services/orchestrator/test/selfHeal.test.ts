import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, type GatewayConfigData, type LLMProvider } from "@cavix/gateway";
import { Reviewer, FakeGitHubClient, makeReviewHandler, pickBestModel } from "@cavix/orchestrator";
import type { GitHubClient } from "@cavix/orchestrator";
import type { ReviewJob } from "@cavix/core";
import { preflight, formatPreflight } from "../src/preflight.ts";

// SELF-HEAL. Providers retire models with no change on our side, so a workspace
// that worked yesterday fails today. Rather than make a human notice, redeploy
// and re-run, Cavix swaps to a model the key can call and finishes the review.

const DIFF = "diff --git a/A.java b/A.java\n--- a/A.java\n+++ b/A.java\n@@ -1 +1,2 @@\n class A {}\n+// x\n";
const RETIRED =
  'google: HTTP 404 : {"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users.","status":"NOT_FOUND"}}';

function job(): ReviewJob {
  return {
    schema_version: "1", idempotency_key: "k", delivery_id: "d", org: "aryanghai12",
    repo: "aryanghai12/Java-Workshop-Notes", repo_id: 1, pr_number: 2, action: "command",
    head_sha: "", base_sha: "", installation_id: 9, priority: 90, title: "t", author: "a",
    enqueued_at: "2026-07-27T00:00:00Z", trigger: "command", command: "review",
    comment_id: 42, author_association: "OWNER", force_fresh: true,
  };
}

/** A provider that rejects the retired model but serves any other. */
function wire(deadModel: string) {
  const seen: string[] = [];
  const provider: LLMProvider = {
    name: "google",
    async complete(req) {
      seen.push(req.model);
      if (req.model === deadModel) throw new Error(RETIRED);
      return {
        text: JSON.stringify({ summary: "ok", findings: [] }),
        model: req.model,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const config: GatewayConfigData = {
    orgs: { acme: { provider: "google", apiKey: "k", model: deadModel } },
  };
  const gateway = new Gateway({ providers: new Map([["google", provider]]), config });
  const github = new FakeGitHubClient({ diff: DIFF });
  return { github, reviewer: new Reviewer({ gateway }), seen };
}

test("a retired model is replaced automatically and the review still posts", async () => {
  const { github, reviewer, seen } = wire("gemini-2.5-flash");
  const saved: Array<[string, string]> = [];

  await makeReviewHandler({
    github, reviewer,
    gate: async () => ({ enabled: true, org: "acme" }),
    suggestModels: async () => ["gemini-2.0-flash", "gemini-2.5-pro", "gemini-1.0-pro"],
    saveModel: async (org, model) => { saved.push([org, model]); return true; },
  })(job());

  assert.equal(github.submissions.length, 1, "the review must still be posted");
  assert.deepEqual(github.reactions.map((r) => r.content), ["eyes", "rocket"], "ends in success, not confused");
  assert.equal(seen[1], "gemini-2.5-pro", "same family and generation preferred");
  assert.deepEqual(saved, [["acme", "gemini-2.5-pro"]], "the choice is persisted, so it heals once");
});

test("the healed model is passed explicitly, beating the gateway's cached config", async () => {
  const { github, reviewer, seen } = wire("gemini-2.5-flash");
  await makeReviewHandler({
    github, reviewer,
    gate: async () => ({ enabled: true, org: "acme" }),
    suggestModels: async () => ["gemini-2.5-pro"],
    saveModel: async () => true,
  })(job());
  // Without the explicit override the retry would reuse the cached dead model.
  assert.deepEqual(seen, ["gemini-2.5-flash", "gemini-2.5-pro"]);
});

test("the user is told what changed, rather than it happening silently", async () => {
  const { github, reviewer } = wire("gemini-2.5-flash");
  await makeReviewHandler({
    github, reviewer,
    gate: async () => ({ enabled: true, org: "acme" }),
    suggestModels: async () => ["gemini-2.5-pro"],
    saveModel: async () => true,
  })(job());
  assert.match(github.comments[0], /switched to `gemini-2\.5-pro`/);
  assert.match(github.comments[0], /AI & BYOK/);
});

test("with no usable alternative it reports the original failure, not a silent success", async () => {
  const { github, reviewer } = wire("gemini-2.5-flash");
  await makeReviewHandler({
    github, reviewer,
    gate: async () => ({ enabled: true, org: "acme" }),
    suggestModels: async () => [],
    saveModel: async () => true,
  })(job());
  assert.equal(github.submissions.length, 0);
  assert.deepEqual(github.reactions.map((r) => r.content), ["eyes", "confused"]);
  assert.match(github.comments[0], /not available to your API key/i);
});

test("healing does not fire for failures that are not about the model", async () => {
  const { github, reviewer } = wire("gemini-2.5-flash");
  let asked = false;
  const broken: GitHubClient = {
    fetchPullDiff: async () => { throw new Error("github: fetch diff HTTP 404 Not Found"); },
    getPull: (r) => github.getPull(r),
    postReview: (r, v) => github.postReview(r, v),
    addReaction: (r, i, c) => github.addReaction(r, i, c),
    createComment: (r, b) => github.createComment(r, b),
    findComment: (r, m) => github.findComment(r, m),
    updateComment: (r, i, b) => github.updateComment(r, i, b),
    whoAmI: () => github.whoAmI(),
  };
  await makeReviewHandler({
    github: broken, reviewer,
    gate: async () => ({ enabled: true, org: "acme" }),
    suggestModels: async () => { asked = true; return ["gemini-2.5-pro"]; },
  })(job());
  assert.equal(asked, false, "a GitHub problem must not trigger a model swap");
});

// ---- ranking ----

test("pickBestModel prefers the same family and generation", () => {
  assert.equal(
    pickBestModel("gemini-2.5-flash", ["gemini-1.0-pro", "gemini-2.5-pro", "gpt-4o"]),
    "gemini-2.5-pro",
  );
  assert.equal(
    pickBestModel("claude-sonnet-4-6", ["claude-opus-5", "claude-sonnet-5", "gemini-2.5-pro"]),
    "claude-sonnet-5",
  );
});

test("pickBestModel never auto-selects a preview build over a stable one", () => {
  assert.equal(
    pickBestModel("gemini-2.5-flash", ["gemini-2.5-flash-preview-01", "gemini-2.5-pro"]),
    "gemini-2.5-pro",
  );
});

test("pickBestModel keeps the current model when it is still available", () => {
  assert.equal(pickBestModel("gemini-2.5-pro", ["gemini-2.5-pro", "gemini-2.0-flash"]), "gemini-2.5-pro");
  assert.equal(pickBestModel("anything", []), null);
});

// ---- preflight ----
//
// Each misconfiguration used to surface one at a time, on a pull request, after a
// deploy. Preflight collapses that loop into one log block read once at boot.

test("preflight reports every misconfiguration together, not one per deploy", async () => {
  const results = await preflight({
    githubConfigError: "github app: CAVIX_APP_ID is empty",
    controlPlaneUrl: undefined,
    internalToken: undefined,
    redisConfigured: false,
    providers: ["anthropic", "fake"],
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });

  const failed = results.filter((r) => !r.ok).map((r) => r.name).sort();
  assert.deepEqual(failed, ["control-plane", "github-auth", "llm-providers", "redis"]);

  const text = formatPreflight(results);
  assert.match(text, /4 blocking problems/);
  assert.match(text, /CAVIX_APP_ID is empty/);
  assert.match(text, /NOT registered: openai, google/);
});

test("preflight passes cleanly when everything is configured", async () => {
  const results = await preflight({
    whoAmI: async () => ({ kind: "app", login: "cavixcode[bot]" }),
    controlPlaneUrl: "https://cavix.example",
    internalToken: "tok",
    redisConfigured: true,
    providers: ["anthropic", "google", "openai", "fake"],
    fetchImpl: (async () => new Response(JSON.stringify({ enabled: false }), { status: 200 })) as unknown as typeof fetch,
  });
  assert.ok(results.every((r) => r.ok), formatPreflight(results));
  assert.match(formatPreflight(results), /all checks passed/);
});

test("preflight names the exact cause of a control-plane 401", async () => {
  const results = await preflight({
    whoAmI: async () => ({ kind: "app", login: "b[bot]" }),
    controlPlaneUrl: "https://cavix.example",
    internalToken: "wrong",
    redisConfigured: true,
    providers: ["anthropic", "google", "openai"],
    fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
  });
  const cp = results.find((r) => r.name === "control-plane")!;
  assert.equal(cp.ok, false);
  assert.match(cp.detail, /CAVIX_INTERNAL_TOKEN differs/);
});

test("preflight flags posting as a human as a warning, not a blocker", async () => {
  const results = await preflight({
    whoAmI: async () => ({ kind: "user", login: "aryanghai12" }),
    controlPlaneUrl: "https://cavix.example",
    internalToken: "tok",
    redisConfigured: true,
    providers: ["anthropic", "google", "openai"],
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });
  const gh = results.find((r) => r.name === "github-auth")!;
  assert.equal(gh.ok, false);
  assert.equal(gh.required, false, "it works, it just wears the wrong identity");
  assert.match(formatPreflight(results), /WARN/);
});
