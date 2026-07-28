import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, type GatewayConfigData, type LLMProvider } from "@cavix/gateway";
import { Reviewer, FakeGitHubClient, makeReviewHandler, pickBestModel, rankModels } from "@cavix/orchestrator";
import type { GitHubClient } from "@cavix/orchestrator";
import type { ReviewJob } from "@cavix/core";
import { preflight, formatPreflight } from "../src/preflight.ts";
import { isZeroQuota } from "../src/workflow/reviewWorkflow.ts";

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
  assert.equal(seen[1], "gemini-2.0-flash", "a flash tier is preferred: free keys have quota there, not on pro");
  assert.deepEqual(saved, [["acme", "gemini-2.0-flash"]], "the choice is persisted, so it heals once");

  // Healing re-runs the whole review against another model. One check row has to
  // survive that: a row per attempt would leave the pull request showing three
  // Cavix checks, two of them spinning until GitHub times them out.
  assert.equal(github.checkRuns.length, 2, "one open, one close, across both attempts");
  assert.equal(github.checkRuns[0].id, github.checkRuns[1].id);
  assert.equal(github.checkRuns[1].status, "completed");
  assert.equal(github.checkRuns[1].conclusion, "success");
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
    fetchFile: (r, p) => github.fetchFile(r, p),
    updatePullBody: (r, b) => github.updatePullBody(r, b),
    postReview: (r, v) => github.postReview(r, v),
    addReaction: (r, i, c) => github.addReaction(r, i, c),
    createComment: (r, b) => github.createComment(r, b),
    findComment: (r, m) => github.findComment(r, m),
    updateComment: (r, i, b) => github.updateComment(r, i, b),
    createCheckRun: (r, i) => github.createCheckRun(r, i),
    updateCheckRun: (r, id, i) => github.updateCheckRun(r, id, i),
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

// ---- the provider lists models it will not actually serve ----
//
// REGRESSION (live): Google's models.list is a GLOBAL catalogue, not a per-key
// entitlement check. It returned `gemini-2.5-flash` while generateContent 404'd
// it for that same key. Because the dead model was still in the list, the ranker
// returned it as its own replacement and healing silently gave up — the user saw
// a failure whose own suggestion list began with the model that had just failed.

test("heals even when the provider still lists the model that just failed", async () => {
  const { github, reviewer, seen } = wire("gemini-2.5-flash");
  const saved: Array<[string, string]> = [];

  await makeReviewHandler({
    github, reviewer,
    gate: async () => ({ enabled: true, org: "acme" }),
    // Exactly what the live API returned: the dead model is listed FIRST.
    suggestModels: async () => [
      "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash",
      "gemini-2.0-flash-001", "gemini-2.0-flash-lite",
    ],
    saveModel: async (org, model) => { saved.push([org, model]); return true; },
  })(job());

  assert.equal(github.submissions.length, 1, "must still post a review");
  assert.deepEqual(github.reactions.map((r) => r.content), ["eyes", "rocket"]);
  assert.notEqual(seen[1], "gemini-2.5-flash", "must not retry the model that just failed");
  assert.equal(seen[1], "gemini-2.0-flash-lite", "highest free quota among the alternatives");
  assert.deepEqual(saved, [["acme", "gemini-2.0-flash-lite"]]);
});

test("walks down the ranked list when a candidate is ALSO closed to this key", async () => {
  // Both the saved model and the top candidate are listed but unusable.
  const closed = new Set(["gemini-2.5-flash", "gemini-2.5-pro"]);
  const seen: string[] = [];
  const provider: LLMProvider = {
    name: "google",
    async complete(req) {
      seen.push(req.model);
      if (closed.has(req.model)) throw new Error(RETIRED.replace("gemini-2.5-flash", req.model));
      return { text: JSON.stringify({ summary: "ok", findings: [] }), model: req.model,
               usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const gateway = new Gateway({
    providers: new Map([["google", provider]]),
    config: { orgs: { acme: { provider: "google", apiKey: "k", model: "gemini-2.5-flash" } } },
  });
  const github = new FakeGitHubClient({ diff: DIFF });

  await makeReviewHandler({
    github, reviewer: new Reviewer({ gateway }),
    gate: async () => ({ enabled: true, org: "acme" }),
    suggestModels: async () => ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    saveModel: async () => true,
  })(job());

  // Flash is tried before pro now, so the closed pro is reached second-to-last.
  assert.deepEqual(seen, ["gemini-2.5-flash", "gemini-2.0-flash"]);
  assert.equal(github.submissions.length, 1, "the next usable candidate posts the review");
});

test("a quota error during healing stops the walk instead of burning every candidate", async () => {
  const seen: string[] = [];
  const provider: LLMProvider = {
    name: "google",
    async complete(req) {
      seen.push(req.model);
      if (req.model === "gemini-2.5-flash") throw new Error(RETIRED);
      throw new Error('google: HTTP 429 : {"error":{"message":"Quota exceeded"}}');
    },
  };
  const gateway = new Gateway({
    providers: new Map([["google", provider]]),
    config: { orgs: { acme: { provider: "google", apiKey: "k", model: "gemini-2.5-flash" } } },
  });
  const github = new FakeGitHubClient({ diff: DIFF });

  await makeReviewHandler({
    github, reviewer: new Reviewer({ gateway }),
    gate: async () => ({ enabled: true, org: "acme" }),
    suggestModels: async () => ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro"],
    saveModel: async () => true,
  })(job());

  // Dead model + exactly one candidate: a quota problem hits every model equally,
  // so trying the rest would just burn quota for the same answer.
  assert.equal(seen.length, 2, `expected to stop after the first quota error, got ${seen.join(", ")}`);
  assert.match(github.comments[0], /quota/i);
});

test("the failure comment never suggests the model that just failed", async () => {
  const { github, reviewer } = wire("gemini-2.5-flash");
  await makeReviewHandler({
    github, reviewer,
    gate: async () => ({ enabled: true, org: "acme" }),
    // Everything is closed, so healing cannot succeed and we fall through to the
    // explanation — which must not recommend the dead model.
    suggestModels: async () => ["gemini-2.5-flash"],
    saveModel: async () => true,
  })(job());

  assert.match(github.comments[0], /could not finish/i);
  assert.doesNotMatch(github.comments[0], /Models your key can use right now/,
    "the only listed model was the dead one, so there is nothing to suggest");
});

test("rankModels returns the whole ordered list, not just a winner", () => {
  const ranked = rankModels("gemini-2.5-flash", ["gemini-2.0-flash", "gemini-2.5-pro", "gemini-1.0-pro"]);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0], "gemini-2.0-flash", "a usable flash tier ranks first");
  assert.deepEqual(rankModels("x", []), []);
});

// ---- per-model quota (the user's real Google AI Studio table) ----
//
// REGRESSION (live): `limit: 0` is granted PER MODEL, not per account. This key
// held 20 requests/day on 2.5-flash and exactly 0 on 2.5-pro. Two bugs fell out:
// ranking preferred "pro" (the tier a free key is least likely to have), and a
// quota error stopped the walk instead of moving to the next model.

/** Zero-quota is the 429 Google returns when a model is granted 0 for this key. */
const zeroQuota = (model: string) =>
  `google: HTTP 429 : {"error":{"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: ${model}"}}`;

test("walks past models the key has ZERO quota for, and posts the review", async () => {
  // Exactly the user's table: pro tiers are 0/0, flash tiers carry the quota.
  const noQuota = new Set(["gemini-2.5-pro", "gemini-3.1-pro", "gemini-2.0-flash"]);
  const tried: string[] = [];
  const provider: LLMProvider = {
    name: "google",
    async complete(req) {
      tried.push(req.model);
      if (req.model === "gemini-2.5-flash") throw new Error(RETIRED);
      if (noQuota.has(req.model)) throw new Error(zeroQuota(req.model));
      return { text: JSON.stringify({ summary: "ok", findings: [] }), model: req.model,
               usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const gateway = new Gateway({
    providers: new Map([["google", provider]]),
    config: { orgs: { acme: { provider: "google", apiKey: "k", model: "gemini-2.5-flash" } } },
  });
  const github = new FakeGitHubClient({ diff: DIFF });
  let saved = "";

  await makeReviewHandler({
    github, reviewer: new Reviewer({ gateway }),
    gate: async () => ({ enabled: true, org: "acme" }),
    suggestModels: async () => [
      "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-pro",
      "gemini-2.0-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite",
    ],
    saveModel: async (_o, m) => { saved = m; return true; },
  })(job());

  assert.equal(github.submissions.length, 1, "a review must still be posted");
  assert.deepEqual(github.reactions.map((r) => r.content), ["eyes", "rocket"]);
  assert.ok(!noQuota.has(saved) && saved !== "gemini-2.5-flash", `settled on an unusable model: ${saved}`);
  assert.ok(tried.length <= 6, `too many billable attempts: ${tried.join(", ")}`);
});

test("ranking prefers the tiers a FREE key actually has quota for", () => {
  // Free Gemini keys get 0/day on pro and 20-500/day on flash and lite.
  const available = ["gemini-2.5-pro", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  const ranked = rankModels("gemini-2.5-flash", available);
  assert.ok(/flash/.test(ranked[0]), `expected a flash tier first, got ${ranked[0]}`);
  assert.ok(ranked.indexOf("gemini-2.5-pro") > 1, "pro tiers must rank below flash for healing");
});

test("ranking never picks a non-text model as a code reviewer", () => {
  const ranked = rankModels("gemini-2.5-flash", [
    "gemini-embedding-1", "imagen-4-generate", "veo-3-generate",
    "gemini-2.5-flash-tts", "gemini-3.5-flash",
  ]);
  assert.equal(ranked[0], "gemini-3.5-flash");
  for (const junk of ["gemini-embedding-1", "imagen-4-generate", "veo-3-generate"]) {
    assert.ok(ranked.indexOf(junk) > 0, `${junk} must never rank first`);
  }
});

test("a REAL rate limit still stops the walk (it is not model-specific)", async () => {
  const tried: string[] = [];
  const provider: LLMProvider = {
    name: "google",
    async complete(req) {
      tried.push(req.model);
      if (req.model === "gemini-2.5-flash") throw new Error(RETIRED);
      // No "limit: 0" — this is going too fast, and affects every model.
      throw new Error('google: HTTP 429 : {"error":{"message":"Resource exhausted, please retry shortly"}}');
    },
  };
  const gateway = new Gateway({
    providers: new Map([["google", provider]]),
    config: { orgs: { acme: { provider: "google", apiKey: "k", model: "gemini-2.5-flash" } } },
  });
  const github = new FakeGitHubClient({ diff: DIFF });

  await makeReviewHandler({
    github, reviewer: new Reviewer({ gateway }),
    gate: async () => ({ enabled: true, org: "acme" }),
    suggestModels: async () => ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3-flash"],
    saveModel: async () => true,
  })(job());

  assert.equal(tried.length, 2, `a real rate limit must not burn every model: ${tried.join(", ")}`);
  assert.match(github.comments[0], /rate-limited|quota/i);
});

test("isZeroQuota separates 'no quota for this model' from 'slow down'", () => {
  assert.equal(isZeroQuota(zeroQuota("gemini-2.5-pro")), true);
  assert.equal(isZeroQuota("google: HTTP 429 : Resource exhausted, retry shortly"), false);
  assert.equal(isZeroQuota("google: HTTP 429 : limit: 20, model: x"), false);
});
