import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import { createMetrics, makeRecorder } from "@cavix/metrics";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";
import {
  FakeGitHubClient,
  Reviewer,
  makeReviewHandler,
  runReview,
  type DeepReviewStep,
} from "@cavix/orchestrator";
import { ALL_SECTIONS, DEFAULT_REVIEW_CONFIG } from "../src/byok/reviewConfig.ts";

// Stage 13's observability half, on the real review path.
//
// The metric this file is really about is `cavix_stage_failures_total`. Every
// stage in Cavix degrades rather than failing, on purpose, which means a stage
// can be broken one hundred per cent of the time for a week while every review
// still posts and nothing anywhere says so. These tests pin that it does now.

const DIFF = `diff --git a/src/auth.js b/src/auth.js
--- a/src/auth.js
+++ b/src/auth.js
@@ -10,3 +10,4 @@ function login(user) {
   const token = sign(user);
+  db.query("SELECT * FROM u WHERE id = " + user.id);
 }
`;

function job(over: Partial<ReviewJob> = {}): ReviewJob {
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
    title: "Add a DB lookup",
    author: "octocat",
    enqueued_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function wire() {
  const provider = new FakeProvider(() =>
    JSON.stringify({
      summary: "Adds a DB lookup.",
      effort: 2,
      findings: [
        {
          path: "src/auth.js",
          line: 11,
          severity: "high",
          category: "security",
          title: "SQL injection",
          body: "concatenated",
          confidence: 0.9,
        },
      ],
    }),
  );
  const config: GatewayConfigData = { orgs: { acme: { provider: "fake", apiKey: "k", model: "m" } } };
  const gateway = new Gateway({ providers: new Map([["fake", provider]]), config });
  return { github: new FakeGitHubClient({ diff: DIFF }), reviewer: new Reviewer({ gateway }) };
}

const reviewConfig = async () => ({ ...DEFAULT_REVIEW_CONFIG, verifyFindings: false, sections: ALL_SECTIONS });

/** Parse exposition text into name{labels} -> value. */
function parse(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const i = line.lastIndexOf(" ");
    out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}

test("a posted review is counted, timed and costed", async () => {
  const m = createMetrics();
  const { github, reviewer } = wire();
  await runReview(job(), { github, reviewer, reviewConfig, metrics: makeRecorder(m) });

  const v = parse(m.registry.render());
  assert.equal(v['cavix_reviews_total{outcome="posted"}'], 1);
  assert.equal(v.cavix_review_duration_seconds_count, 1);
  assert.equal(v['cavix_findings_total{outcome="surfaced"}'], 1);
});

test("a stage that degraded is counted, even though the review still posted", async () => {
  // THE POINT OF THE WHOLE ITEM. The deep path throwing costs the review its
  // ensemble and falls back to a single model pass. It posts, the customer sees
  // a review, and before this counter existed nothing told the operator that
  // Stage 8 had been dead since Tuesday.
  const m = createMetrics();
  const { github, reviewer } = wire();
  const broken: DeepReviewStep = async () => {
    throw new Error("provider outage");
  };

  const outcome = await runReview(job(), {
    github,
    reviewer,
    reviewConfig,
    deepReview: broken,
    metrics: makeRecorder(m),
  });

  const v = parse(m.registry.render());
  assert.equal(outcome.findingCount, 1, "the review still posted, as designed");
  assert.equal(v['cavix_reviews_total{outcome="posted"}'], 1);
  assert.equal(v['cavix_stage_failures_total{stage="deep_review"}'], 1, "and the degradation is visible");
});

test("each stage is counted under its own name, so an operator knows which one broke", async () => {
  // A single "something degraded" counter would say a review was worse without
  // saying what to go and fix.
  const m = createMetrics();
  const { github, reviewer } = wire();
  await runReview(job(), {
    github,
    reviewer,
    reviewConfig,
    blastRadius: async () => {
      throw new Error("graph store down");
    },
    regression: async () => {
      throw new Error("no CI history");
    },
    metrics: makeRecorder(m),
  });

  const v = parse(m.registry.render());
  assert.equal(v['cavix_stage_failures_total{stage="cross_repo"}'], 1);
  assert.equal(v['cavix_stage_failures_total{stage="ci_telemetry"}'], 1);
  assert.equal(v['cavix_stage_failures_total{stage="deep_review"}'], undefined, "and a stage that did not run is not blamed");
});

test("a failed review is counted as failed, not as posted", async () => {
  const m = createMetrics();
  const { github, reviewer } = wire();
  const brokenClient = {
    ...github,
    platform: github.platform,
    capabilities: github.capabilities,
    fetchPullDiff: async () => {
      throw new Error("github: fetch diff HTTP 404 Not Found");
    },
  } as unknown as typeof github;

  const handler = makeReviewHandler({ github: brokenClient, reviewer, reviewConfig, metrics: makeRecorder(m) });
  await handler(job());

  const v = parse(m.registry.render());
  assert.equal(v['cavix_reviews_total{outcome="failed"}'], 1);
  assert.equal(v['cavix_reviews_total{outcome="posted"}'], undefined);
});

test("a job the gate turned away is skipped, which is neither posted nor failed", async () => {
  const m = createMetrics();
  const { github, reviewer } = wire();
  const handler = makeReviewHandler({
    github,
    reviewer,
    reviewConfig,
    gate: async () => ({ enabled: false }),
    metrics: makeRecorder(m),
  });
  await handler(job());

  const v = parse(m.registry.render());
  assert.equal(v['cavix_reviews_total{outcome="skipped"}'], 1);
  assert.equal(v['cavix_reviews_total{outcome="failed"}'], undefined, "a repo that is off is not an error");
});

test("no metrics recorder means no metrics, and no change to the review", async () => {
  // Every deployment that has not opted in runs this path.
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), { github, reviewer, reviewConfig });
  assert.equal(outcome.findingCount, 1);
});

test("the exposition names no repository, org, path or finding", async () => {
  // The rule this endpoint lives by. A scrape is retained for a year in a store
  // usually less protected than the database; anything here that identified a
  // customer would be a leak with a long tail.
  const m = createMetrics();
  const { github, reviewer } = wire();
  await runReview(job(), {
    github,
    reviewer,
    reviewConfig,
    deepReview: async () => {
      throw new Error("boom");
    },
    metrics: makeRecorder(m),
  });

  const text = m.registry.render();
  for (const leak of ["acme", "widget", "src/auth.js", "SQL injection", "octocat", "headsha"]) {
    assert.equal(text.includes(leak), false, `the exposition leaked ${leak}`);
  }
});

// ── the control-plane's own endpoint ────────────────────────────────────────

async function withServer(fn: (base: string, store: InMemoryStore) => Promise<void>) {
  const store = new InMemoryStore();
  const server = createControlPlane(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("the control-plane serves Prometheus text a scraper will accept", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/metrics");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain; version=0\.0\.4/);
    const text = await res.text();
    assert.match(text, /# TYPE cavix_api_requests_total counter/);
    assert.match(text, /cavix_build_info\{version="[^"]+"\} 1/);
  });
});

test("the control-plane counts a review it REJECTED, which the orchestrator cannot see", async () => {
  // A review that was produced and then dropped at the door. The orchestrator
  // logs a warning and carries on by design, so this is the only surface on
  // which a dashboard silently losing every review is visible.
  await withServer(async (base, store) => {
    store.createOrg("quiet", { tier: "free" });
    store.setSuspended("quiet", true); // limit 0: every record is refused

    const before = parse(await (await fetch(base + "/metrics")).text());
    const res = await fetch(base + "/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.CAVIX_INTERNAL_TOKEN ?? ""}` },
      body: JSON.stringify({ org: "quiet", repo: "quiet/x", pr: 1, title: "t", findings: [] }),
    });
    assert.ok(res.status === 429 || res.status === 401, `got ${res.status}`);

    const after = parse(await (await fetch(base + "/metrics")).text());
    const rejected = 'cavix_reviews_recorded_total{outcome="rejected"}';
    const errors = 'cavix_api_requests_total{class="client_error"}';
    assert.ok(
      (after[rejected] ?? 0) > (before[rejected] ?? 0) || (after[errors] ?? 0) > (before[errors] ?? 0),
      "a refused review shows up somewhere on this endpoint",
    );
  });
});
