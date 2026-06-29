import { test } from "node:test";
import assert from "node:assert/strict";
import type { Severity } from "@cavix/core";
import { InMemoryAnalyticsStore, computeTeamReport, computeOrgRollup, type ReviewEvent } from "@cavix/analytics";

function ev(over: Partial<ReviewEvent>): ReviewEvent {
  return {
    team: "payments", repo: "payments/api", reviewId: "r", findingId: "f" + Math.random(),
    severity: "high" as Severity, source: "llm", verified: false, fixPrOpened: false, decision: "none",
    at: new Date().toISOString(), ...over,
  };
}

function paymentsEvents(): ReviewEvent[] {
  return [
    ev({ severity: "critical", verified: true, decision: "accepted", fixPrOpened: true }),
    ev({ severity: "critical", verified: true, decision: "accepted", fixPrOpened: true }),
    ev({ severity: "critical", verified: true, decision: "accepted" }),
    ev({ severity: "high", verified: true, decision: "accepted" }),
    ev({ severity: "high", verified: true, decision: "accepted" }),
    ev({ severity: "medium", decision: "rejected" }), // false positive
    ev({ severity: "low", decision: "none" }),
    ev({ severity: "low", decision: "none" }),
  ];
}

test("team report: action rate, defects caught, reviewer-hours saved", () => {
  const r = computeTeamReport(paymentsEvents());
  assert.equal(r.totalFindings, 8);
  assert.equal(r.actedOn, 5); // 5 accepted (2 of which also got fix PRs)
  assert.equal(r.actionRate, 0.63); // 5/8
  assert.equal(r.defectsCaught, 5); // verified
  assert.equal(r.falsePositives, 1);
  assert.equal(r.fixPrsOpened, 2);
  // 3*60 + 2*40 (accepted/verified) + 2*30 (fix PRs) - 1*3 (rejected) = 317 min
  assert.equal(r.reviewerHoursSaved, 5.28);
});

test("org rollup sums teams and produces ROI numbers", () => {
  const store = new InMemoryAnalyticsStore();
  for (const e of paymentsEvents()) store.ingest(e);
  store.ingest(ev({ team: "search", severity: "high", verified: true, decision: "accepted" }));
  store.ingest(ev({ team: "search", severity: "low", decision: "rejected" }));

  const rollup = computeOrgRollup(store);
  assert.equal(rollup.teams.length, 2);
  assert.equal(rollup.totalFindings, 10);
  assert.equal(rollup.defectsCaught, 6); // 5 + 1
  assert.ok(rollup.reviewerHoursSaved > 5, `expected ROI hours > 5, got ${rollup.reviewerHoursSaved}`);
  assert.ok(rollup.actionRate > 0 && rollup.actionRate <= 1);
});

test("clean team: zero findings → zero (no negative hours)", () => {
  const r = computeTeamReport([]);
  assert.equal(r.totalFindings, 0);
  assert.equal(r.actionRate, 0);
  assert.equal(r.reviewerHoursSaved, 0);
});
