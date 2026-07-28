import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "@cavix/control-plane";

// The numbers behind the Reports page.
//
// Two of them drive real decisions rather than decorating a page: the action-rate
// TREND (the roadmap calls a falling one the earliest churn signal there is) and
// the mute log (a repo switched off is the moment a customer starts leaving).
// Neither existed before; both are asserted here.

function withReview(
  store: InMemoryStore,
  over: {
    org?: string;
    repo?: string;
    pr?: number;
    ageDays?: number;
    costUsd?: number;
    findings?: Array<{ severity: string; verified?: boolean; decision?: "accepted" | "rejected"; category?: string }>;
  } = {},
) {
  const rec = store.saveReview({
    org: over.org ?? "acme",
    repo: over.repo ?? "acme/api",
    pr: over.pr ?? 1,
    title: "t",
    ...(over.costUsd !== undefined ? { costUsd: over.costUsd } : {}),
    model: "claude-opus-5",
    durationMs: 12_000,
    findings: (over.findings ?? []).map((f, i) => ({
      path: `src/f${i}.ts`,
      line: i + 1,
      severity: f.severity as never,
      category: f.category ?? "correctness",
      title: `finding ${i}`,
      body: "",
      source: "llm" as const,
      confidence: 0.8,
      verified: f.verified === true,
    })),
  });
  if (over.ageDays) {
    (rec as { createdAt: string }).createdAt = new Date(Date.now() - over.ageDays * 86_400_000).toISOString();
  }
  (over.findings ?? []).forEach((f, i) => {
    if (f.decision) store.recordDecision(rec.findings[i].id, f.decision, "dev@acme.dev");
  });
  return rec;
}

function seeded(): InMemoryStore {
  const store = new InMemoryStore();
  store.createOrg("acme", { tier: "paid" });
  store.createRepo("acme", "acme/api", { visibility: "private" });
  return store;
}

test("the daily series covers the whole window, including days with nothing", async () => {
  const store = seeded();
  withReview(store, { findings: [{ severity: "high" }] });
  const a = store.analytics("acme", 30);

  assert.equal(a.days.length, 30, "a gap in activity is a zero, not a missing point");
  assert.equal(a.days.at(-1)!.reviews, 1, "today's review lands in today's bucket");
  assert.ok(a.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)), "dates are UTC day keys");
});

test("reviews outside the window are excluded", async () => {
  const store = seeded();
  withReview(store, { pr: 1, ageDays: 60, findings: [{ severity: "high" }] });
  withReview(store, { pr: 2, findings: [{ severity: "low" }] });

  assert.equal(store.analytics("acme", 30).totalFindings, 1);
  assert.equal(store.analytics("acme", 90).totalFindings, 2);
});

test("cost per review reports only what was actually measured", async () => {
  const store = seeded();
  withReview(store, { pr: 1, costUsd: 0.2, findings: [{ severity: "high" }] });
  withReview(store, { pr: 2, costUsd: 0.4, findings: [{ severity: "low" }] });
  // An older review from before cost reporting existed. It must not be counted
  // as $0 and drag the mean down: "not measured" is not "free".
  withReview(store, { pr: 3, findings: [{ severity: "low" }] });

  const a = store.analytics("acme", 30);
  assert.equal(a.totalCostUsd, 0.6);
  assert.equal(a.costPerReview, 0.3, "the mean is over the two priced reviews, not all three");
});

test("a workspace with no cost data reports zero rather than a wrong number", async () => {
  const store = seeded();
  withReview(store, { findings: [{ severity: "high" }] });
  assert.equal(store.analytics("acme", 30).costPerReview, 0);
});

test("the action-rate trend compares the two halves of the window", async () => {
  const store = seeded();
  // First half: 1 of 2 accepted (50%). Second half: 2 of 2 (100%). +50 points.
  withReview(store, { pr: 1, ageDays: 25, findings: [{ severity: "high", decision: "accepted" }, { severity: "low", decision: "rejected" }] });
  withReview(store, { pr: 2, ageDays: 2, findings: [{ severity: "high", decision: "accepted" }, { severity: "low", decision: "accepted" }] });

  assert.equal(store.analytics("acme", 30).actionRateTrend, 50);
});

test("a falling action rate reports a negative trend, which is the churn signal", async () => {
  const store = seeded();
  withReview(store, { pr: 1, ageDays: 25, findings: [{ severity: "high", decision: "accepted" }, { severity: "low", decision: "accepted" }] });
  withReview(store, { pr: 2, ageDays: 2, findings: [{ severity: "high", decision: "rejected" }, { severity: "low", decision: "rejected" }] });

  assert.equal(store.analytics("acme", 30).actionRateTrend, -100);
});

test("a half with no decisions reports no trend, rather than a swing off an empty denominator", async () => {
  const store = seeded();
  withReview(store, { pr: 1, ageDays: 2, findings: [{ severity: "high", decision: "accepted" }] });
  assert.equal(store.analytics("acme", 30).actionRateTrend, 0, "a quiet fortnight is not a trend");
});

test("a repo switched off is recorded, and switching it back on is too", async () => {
  const store = seeded();
  store.recordMute({ org: "acme", scope: "repo", target: "acme/api", restored: false });
  store.recordMute({ org: "acme", scope: "repo", target: "acme/api", restored: true });

  const a = store.analytics("acme", 30);
  assert.equal(a.muteEvents.length, 2);
  assert.equal(a.muteEvents[0].restored, false);
  assert.equal(a.muteEvents[1].restored, true);
});

test("mute events belong to their own workspace", async () => {
  const store = seeded();
  store.createOrg("other", { tier: "paid" });
  store.recordMute({ org: "other", scope: "repo", target: "other/api", restored: false });
  assert.equal(store.analytics("acme", 30).muteEvents.length, 0);
});

test("the per-repo rollup ranks by findings and carries hours saved", async () => {
  const store = seeded();
  store.createRepo("acme", "acme/web", { visibility: "private" });
  withReview(store, { pr: 1, repo: "acme/api", findings: [{ severity: "critical", verified: true }, { severity: "high", verified: true }] });
  withReview(store, { pr: 2, repo: "acme/web", findings: [{ severity: "low" }] });

  const a = store.analytics("acme", 30);
  assert.equal(a.repos.length, 2);
  assert.equal(a.repos[0].repo, "acme/api", "the busiest repository leads");
  assert.equal(a.repos[0].findings, 2);
  assert.equal(a.repos[0].verified, 2);
  assert.ok(a.repos[0].hoursSaved > a.repos[1].hoursSaved, "a critical costs more human time than a low");
});

test("hours saved comes from the analytics package, so one model serves every surface", async () => {
  const store = seeded();
  // The package's model: a verified critical is 60 minutes, a verified high 40.
  withReview(store, { findings: [{ severity: "critical", verified: true }, { severity: "high", verified: true }] });
  assert.equal(store.analytics("acme", 30).reviewerHoursSaved, 1.67, "(60 + 40) / 60");
});

test("verified share is a share of findings, not of reviews", async () => {
  const store = seeded();
  withReview(store, { findings: [{ severity: "high", verified: true }, { severity: "low" }, { severity: "low" }, { severity: "low" }] });
  assert.equal(store.analytics("acme", 30).verifiedShare, 0.25);
});

test("a decision carries what it was about, not just an id", async () => {
  // The Learnings page used to render a column of hashes, which demonstrates
  // nothing to the customer it exists to reassure.
  const store = seeded();
  withReview(store, { findings: [{ severity: "high", category: "security", decision: "rejected", verified: true }] });

  const [d] = store.listDecisions();
  assert.equal(d.title, "finding 0");
  assert.equal(d.severity, "high");
  assert.equal(d.category, "security");
  assert.equal(d.repo, "acme/api");
  assert.equal(d.path, "src/f0.ts");
  assert.equal(d.verified, true);
  assert.equal(d.state, "rejected");
});

test("a review carries its cost, model and duration through to the store", async () => {
  const store = seeded();
  withReview(store, { costUsd: 0.42, findings: [{ severity: "low" }] });
  const [r] = store.listReviews("acme");
  assert.equal(r.costUsd, 0.42);
  assert.equal(r.model, "claude-opus-5");
  assert.equal(r.durationMs, 12_000);
});
